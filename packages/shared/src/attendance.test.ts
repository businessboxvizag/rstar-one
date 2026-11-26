import { describe, expect, it } from "vitest";
import { accruedFor, countLeaveDays, dateInZone, evaluateCheck, minutesInZone, summariseDay, type PolicyRule } from "./attendance.js";

const policy: PolicyRule = {
  workStart: "09:30", workEnd: "18:30", graceMinutes: 15, earlyLeaveMinutes: 15, halfDayMinutes: 240, fullDayMinutes: 480,
  weeklyOffs: [0], allowWfh: false, allowField: true,
};
// RSTAR Visakhapatnam office area (test coordinates only).
const fence = { latitude: 17.7231, longitude: 83.3013, radiusM: 150, maxAccuracyM: 100 };
const now = new Date("2026-11-24T04:00:00Z"); // 09:30 IST
const ist = (hhmm: string, date = "2026-11-24") => new Date(`${date}T${hhmm}:00+05:30`);

describe("evaluateCheck", () => {
  it("verifies an accurate fix inside the geofence", () => {
    const v = evaluateCheck({ mode: "office", latitude: 17.7235, longitude: 83.3015, accuracyM: 20 }, { geofence: fence, policy, now });
    expect(v.result).toBe("verified");
    expect(v.flags).toEqual([]);
    expect(v.distanceM).toBeLessThan(60);
  });
  it("flags outside, low accuracy, mock and missing geofence", () => {
    expect(evaluateCheck({ mode: "office", latitude: 17.74, longitude: 83.3, accuracyM: 10 }, { geofence: fence, policy, now }).flags).toContain("outside_geofence");
    expect(evaluateCheck({ mode: "office", latitude: 17.7231, longitude: 83.3013, accuracyM: 500 }, { geofence: fence, policy, now }).flags).toContain("low_accuracy");
    const m = evaluateCheck({ mode: "office", latitude: 17.7231, longitude: 83.3013, accuracyM: 5, mocked: true }, { geofence: fence, policy, now });
    expect(m).toMatchObject({ result: "pending_exception", flags: ["mock_location"] });
    expect(evaluateCheck({ mode: "office", latitude: 1, longitude: 1, accuracyM: 5 }, { geofence: null, policy, now }).flags).toContain("no_geofence_configured");
    expect(evaluateCheck({ mode: "office" }, { geofence: fence, policy, now }).flags).toContain("no_location");
  });
  it("detects impossible travel and clock skew", () => {
    const v = evaluateCheck(
      { mode: "office", latitude: 17.7231, longitude: 83.3013, accuracyM: 10, clientTime: new Date(now.getTime() - 20 * 60_000) },
      { geofence: fence, policy, now, previous: { latitude: 17.385, longitude: 78.4867, at: new Date(now.getTime() - 30 * 60_000) } }, // Hyderabad 30 min ago
    );
    expect(v.flags).toEqual(expect.arrayContaining(["impossible_travel", "clock_skew"]));
  });
  it("applies WFH and field policy", () => {
    expect(evaluateCheck({ mode: "wfh" }, { geofence: fence, policy, now }).result).toBe("pending_exception");
    expect(evaluateCheck({ mode: "wfh" }, { geofence: fence, policy: { ...policy, allowWfh: true }, now }).result).toBe("remote");
    expect(evaluateCheck({ mode: "field", latitude: 16.5, longitude: 80.6, accuracyM: 30 }, { geofence: fence, policy, now }).result).toBe("remote");
    expect(evaluateCheck({ mode: "field" }, { geofence: fence, policy, now }).result).toBe("pending_exception");
  });
});

describe("time zone helpers", () => {
  it("uses the branch time zone, not UTC", () => {
    expect(dateInZone(new Date("2026-11-24T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11-25");
    expect(minutesInZone(new Date("2026-11-24T04:00:00Z"), "Asia/Kolkata")).toBe(570);
  });
});

describe("summariseDay", () => {
  const base = { date: "2026-11-24", timeZone: "Asia/Kolkata", policy, holiday: false, leave: null, today: "2026-11-25" } as const;
  const ev = (kind: "check_in" | "check_out", at: Date, result: "verified" | "pending_exception" | "rejected" = "verified") => ({ kind, mode: "office" as const, at, result });

  it("present, late, half day, absent", () => {
    expect(summariseDay({ ...base, events: [ev("check_in", ist("09:35")), ev("check_out", ist("18:40"))] })).toMatchObject({ status: "present", lateMinutes: 0, workedMinutes: 545 });
    expect(summariseDay({ ...base, events: [ev("check_in", ist("10:05")), ev("check_out", ist("18:30"))] })).toMatchObject({ status: "late", lateMinutes: 35 });
    expect(summariseDay({ ...base, events: [ev("check_in", ist("09:30")), ev("check_out", ist("14:00"))] })).toMatchObject({ status: "half_day", earlyMinutes: 270 });
    expect(summariseDay({ ...base, events: [] }).status).toBe("absent");
  });
  it("sums multiple sessions and ignores rejected events", () => {
    const s = summariseDay({ ...base, events: [ev("check_in", ist("09:30")), ev("check_out", ist("13:30")), ev("check_in", ist("14:30")), ev("check_out", ist("18:30")), ev("check_in", ist("19:00"), "rejected")] });
    expect(s).toMatchObject({ status: "present", workedMinutes: 480 });
  });
  it("missing check-out needs review; today is in progress", () => {
    expect(summariseDay({ ...base, events: [ev("check_in", ist("09:30"))] })).toMatchObject({ status: "pending_review", needsReview: true });
    expect(summariseDay({ ...base, today: "2026-11-24", events: [ev("check_in", ist("09:30"))] }).status).toBe("in_progress");
  });
  it("pending exception holds the day for review", () => {
    expect(summariseDay({ ...base, events: [ev("check_in", ist("09:30"), "pending_exception"), ev("check_out", ist("18:30"))] }).status).toBe("pending_review");
  });
  it("holidays, weekly offs, leave and corrections", () => {
    expect(summariseDay({ ...base, holiday: true, events: [] }).status).toBe("holiday");
    expect(summariseDay({ ...base, date: "2026-11-22", events: [] }).status).toBe("weekly_off"); // Sunday
    expect(summariseDay({ ...base, leave: "full", events: [] }).status).toBe("on_leave");
    expect(summariseDay({ ...base, leave: "half", events: [ev("check_in", ist("14:00")), ev("check_out", ist("18:30"))] }).status).toBe("half_day_leave");
    const c = summariseDay({ ...base, events: [ev("check_in", ist("09:30"))], correction: { checkInAt: null, checkOutAt: ist("18:30"), mode: "office" } });
    expect(c).toMatchObject({ status: "present", source: "correction", workedMinutes: 540 });
  });
});

describe("leave rules", () => {
  const sunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
  it("counts working days with halves", () => {
    expect(countLeaveDays({ startDate: "2026-11-23", endDate: "2026-11-28", startHalf: false, endHalf: false }, sunday)).toBe(6);
    expect(countLeaveDays({ startDate: "2026-11-27", endDate: "2026-11-30", startHalf: true, endHalf: true }, sunday)).toBe(2); // Fri½ Sat Sun(off) Mon½
    expect(countLeaveDays({ startDate: "2026-11-24", endDate: "2026-11-24", startHalf: true, endHalf: false }, sunday)).toBe(0.5);
    expect(countLeaveDays({ startDate: "2026-11-22", endDate: "2026-11-22", startHalf: false, endHalf: false }, sunday)).toBe(0);
  });
  it("accrues monthly and pro-rates yearly from joining", () => {
    expect(accruedFor({ annualQuota: 12, accrual: "monthly" }, 2026, "2025-03-01", "2026-11-24")).toBe(11);
    expect(accruedFor({ annualQuota: 12, accrual: "monthly" }, 2026, "2026-07-10", "2026-11-24")).toBe(5);
    expect(accruedFor({ annualQuota: 12, accrual: "yearly" }, 2026, "2026-07-10", "2026-11-24")).toBe(6);
    expect(accruedFor({ annualQuota: 15, accrual: "yearly" }, 2026, "2020-01-01", "2026-11-24")).toBe(15);
    expect(accruedFor({ annualQuota: 12, accrual: "monthly" }, 2025, "2020-01-01", "2026-11-24")).toBe(12);
  });
});

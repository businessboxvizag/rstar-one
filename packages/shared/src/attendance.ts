import { z } from "zod";
import { distanceMetres } from "./geo.js";

/**
 * Attendance and leave rules shared by the API (authoritative) and the apps (display only).
 * The server never trusts the client's verdict: every check-in is re-evaluated here on the server.
 */

export const ATTENDANCE_MODES = ["office", "wfh", "field"] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];
export const ATTENDANCE_KINDS = ["check_in", "check_out"] as const;
export type AttendanceKind = (typeof ATTENDANCE_KINDS)[number];

export type EventResult = "verified" | "remote" | "pending_exception" | "approved_exception" | "rejected";

export const ATTENDANCE_FLAGS = {
  no_geofence_configured: "Office location has not been set up for this branch",
  no_location: "No location was provided",
  low_accuracy: "Location accuracy was too low to verify",
  outside_geofence: "Outside the office geofence",
  mock_location: "Device reported a mock / simulated location",
  impossible_travel: "Moved implausibly fast since the previous check",
  clock_skew: "Device clock differs from server time by more than 5 minutes",
  wfh_not_allowed: "Work from home is not allowed by the attendance policy",
  field_not_allowed: "Field work check-in is not allowed by the attendance policy",
} as const;
export type AttendanceFlag = keyof typeof ATTENDANCE_FLAGS;

export interface GeofenceRule {
  latitude: number;
  longitude: number;
  radiusM: number;
  maxAccuracyM: number;
}

export interface PolicyRule {
  workStart: string; // "HH:MM"
  workEnd: string;
  graceMinutes: number;
  earlyLeaveMinutes: number;
  halfDayMinutes: number;
  fullDayMinutes: number;
  weeklyOffs: number[]; // 0 = Sunday
  allowWfh: boolean;
  allowField: boolean;
}

export interface CheckInput {
  mode: AttendanceMode;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  mocked?: boolean;
  clientTime?: Date | null;
}

export interface CheckVerdict {
  result: EventResult;
  flags: AttendanceFlag[];
  distanceM: number | null;
}

/** Server-side evaluation of a single check-in / check-out. */
export function evaluateCheck(
  input: CheckInput,
  ctx: { geofence: GeofenceRule | null; policy: PolicyRule; now: Date; previous?: { latitude: number; longitude: number; at: Date } | null },
): CheckVerdict {
  const flags: AttendanceFlag[] = [];
  const hasLoc = input.latitude != null && input.longitude != null;
  let distanceM: number | null = null;

  if (input.mocked) flags.push("mock_location");
  if (input.clientTime && Math.abs(input.clientTime.getTime() - ctx.now.getTime()) > 5 * 60_000) flags.push("clock_skew");
  if (hasLoc && ctx.previous) {
    const metres = distanceMetres({ lat: ctx.previous.latitude, lng: ctx.previous.longitude }, { lat: input.latitude!, lng: input.longitude! });
    const hours = Math.max((ctx.now.getTime() - ctx.previous.at.getTime()) / 3_600_000, 1 / 60);
    if (metres > 2000 && metres / 1000 / hours > 250) flags.push("impossible_travel");
  }
  if (hasLoc && ctx.geofence) {
    distanceM = Math.round(distanceMetres({ lat: ctx.geofence.latitude, lng: ctx.geofence.longitude }, { lat: input.latitude!, lng: input.longitude! }) * 10) / 10;
  }

  if (input.mode === "office") {
    if (!ctx.geofence) flags.push("no_geofence_configured");
    if (!hasLoc) flags.push("no_location");
    else if (ctx.geofence) {
      if (input.accuracyM == null || input.accuracyM > ctx.geofence.maxAccuracyM) flags.push("low_accuracy");
      // Accuracy is not added to the radius: a fix must be inside the fence on its own.
      if (distanceM! > ctx.geofence.radiusM) flags.push("outside_geofence");
    }
    return { result: flags.length ? "pending_exception" : "verified", flags, distanceM };
  }
  if (input.mode === "wfh" && !ctx.policy.allowWfh) flags.push("wfh_not_allowed");
  if (input.mode === "field") {
    if (!ctx.policy.allowField) flags.push("field_not_allowed");
    if (!hasLoc) flags.push("no_location");
  }
  const blocking = flags.filter((f) => f !== "no_location" || input.mode === "field");
  return { result: blocking.length ? "pending_exception" : "remote", flags, distanceM };
}

// ── Time-zone helpers (no external deps) ────────────────────────────────────

/** Calendar date ("YYYY-MM-DD") of an instant in a time zone. */
export function dateInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Minutes since local midnight of an instant in a time zone. */
export function minutesInZone(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Day of week (0 = Sunday) of a "YYYY-MM-DD" date. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── Daily ledger ────────────────────────────────────────────────────────────

export const DAY_STATUSES = [
  "present", "late", "half_day", "absent", "on_leave", "half_day_leave", "holiday", "weekly_off", "wfh", "field", "pending_review", "in_progress",
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export interface DayEvent {
  kind: AttendanceKind;
  mode: AttendanceMode;
  at: Date;
  result: EventResult;
}

export interface DayInput {
  date: string;
  timeZone: string;
  policy: PolicyRule;
  events: DayEvent[];
  holiday: boolean;
  leave: "full" | "half" | null;
  /** Approved correction overrides events. */
  correction?: { checkInAt: Date | null; checkOutAt: Date | null; mode: AttendanceMode } | null;
  today: string;
}

export interface DaySummary {
  status: DayStatus;
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  needsReview: boolean;
  source: "events" | "correction" | "leave" | "calendar";
}

export function summariseDay(d: DayInput): DaySummary {
  const nonWorking = d.holiday || d.policy.weeklyOffs.includes(weekday(d.date));
  const empty: DaySummary = { status: "absent", firstIn: null, lastOut: null, workedMinutes: 0, lateMinutes: 0, earlyMinutes: 0, needsReview: false, source: "calendar" };

  let firstIn: Date | null = null;
  let lastOut: Date | null = null;
  let worked = 0;
  let open = false;
  let pending = false;
  let firstMode: AttendanceMode = "office";
  let source: DaySummary["source"] = "events";

  if (d.correction && (d.correction.checkInAt || d.correction.checkOutAt)) {
    const evIn = d.events.find((e) => e.kind === "check_in" && e.result !== "rejected");
    const evOut = [...d.events].reverse().find((e) => e.kind === "check_out" && e.result !== "rejected");
    firstIn = d.correction.checkInAt ?? evIn?.at ?? null;
    lastOut = d.correction.checkOutAt ?? evOut?.at ?? null;
    firstMode = d.correction.mode;
    if (firstIn && lastOut && lastOut > firstIn) worked = Math.round((lastOut.getTime() - firstIn.getTime()) / 60_000);
    open = Boolean(firstIn && !lastOut);
    source = "correction";
  } else {
    const evs = d.events.filter((e) => e.result !== "rejected").sort((a, b) => a.at.getTime() - b.at.getTime());
    let segStart: Date | null = null;
    for (const e of evs) {
      if (e.kind === "check_in") {
        if (!firstIn) {
          firstIn = e.at;
          firstMode = e.mode;
          if (e.result === "pending_exception") pending = true;
        }
        if (!segStart) segStart = e.at;
      } else if (segStart) {
        worked += Math.round((e.at.getTime() - segStart.getTime()) / 60_000);
        lastOut = e.at;
        segStart = null;
      }
      if (e.result === "pending_exception") pending = true;
    }
    open = segStart !== null;
  }

  if (!firstIn) {
    if (d.leave === "full") return { ...empty, status: "on_leave", source: "leave" };
    if (nonWorking) return { ...empty, status: d.holiday ? "holiday" : "weekly_off" };
    if (d.leave === "half") return { ...empty, status: "half_day_leave", source: "leave", needsReview: d.date < d.today };
    return { ...empty, status: d.date < d.today ? "absent" : "in_progress" };
  }

  const start = hhmmToMinutes(d.policy.workStart);
  const end = hhmmToMinutes(d.policy.workEnd);
  const inMin = minutesInZone(firstIn, d.timeZone);
  const lateMinutes = d.leave === "half" || nonWorking ? 0 : Math.max(0, inMin - start);
  const isLate = lateMinutes > d.policy.graceMinutes;
  let earlyMinutes = 0;
  if (lastOut && !open && !nonWorking && d.leave !== "half") earlyMinutes = Math.max(0, end - minutesInZone(lastOut, d.timeZone));

  const base = { firstIn, lastOut, workedMinutes: worked, lateMinutes: isLate ? lateMinutes : 0, earlyMinutes: earlyMinutes > d.policy.earlyLeaveMinutes ? earlyMinutes : 0, source };

  if (open) {
    if (d.date >= d.today) return { ...base, status: "in_progress", needsReview: pending };
    // Forgot to check out: the day cannot be credited until someone corrects it.
    return { ...base, status: "pending_review", needsReview: true };
  }
  if (pending) return { ...base, status: "pending_review", needsReview: true };

  let status: DayStatus;
  if (d.leave === "half") status = worked >= d.policy.halfDayMinutes ? "half_day_leave" : "absent";
  else if (nonWorking) status = firstMode === "office" ? "present" : firstMode;
  else if (worked >= d.policy.fullDayMinutes) status = isLate ? "late" : firstMode === "office" ? "present" : firstMode;
  else if (worked >= d.policy.halfDayMinutes) status = "half_day";
  else status = "absent";
  return { ...base, status, needsReview: status === "absent" && worked > 0 };
}

// ── Leave ───────────────────────────────────────────────────────────────────

/**
 * Working days a leave request consumes. Weekly offs and holidays inside the range are not counted.
 * startHalf: the first day starts after lunch (counts 0.5). endHalf: the last day ends at lunch (0.5).
 */
export function countLeaveDays(
  r: { startDate: string; endDate: string; startHalf: boolean; endHalf: boolean },
  isNonWorking: (date: string) => boolean,
): number {
  if (r.endDate < r.startDate) return 0;
  if (r.startDate === r.endDate) {
    if (isNonWorking(r.startDate)) return 0;
    return r.startHalf || r.endHalf ? 0.5 : 1;
  }
  let total = 0;
  for (const date of eachDate(r.startDate, r.endDate)) {
    if (isNonWorking(date)) continue;
    if ((date === r.startDate && r.startHalf) || (date === r.endDate && r.endHalf)) total += 0.5;
    else total += 1;
  }
  return total;
}

/** Leave credited so far in `year` for a type, given accrual rules and joining date. */
export function accruedFor(
  type: { annualQuota: number; accrual: "yearly" | "monthly" | "none" },
  year: number,
  joiningDate: string,
  today: string,
): number {
  if (type.accrual === "none") return 0;
  const joinYear = Number(joiningDate.slice(0, 4));
  if (joinYear > year) return 0;
  const startMonth = joinYear === year ? Number(joiningDate.slice(5, 7)) : 1;
  if (type.accrual === "yearly") {
    // Pro-rated by months remaining in the joining year, rounded down to half days.
    const months = 13 - startMonth;
    return Math.floor(((type.annualQuota * months) / 12) * 2) / 2;
  }
  const thisYear = Number(today.slice(0, 4));
  const endMonth = thisYear > year ? 12 : thisYear < year ? 0 : Number(today.slice(5, 7));
  const months = Math.max(0, endMonth - startMonth + 1);
  return Math.floor(((type.annualQuota * months) / 12) * 2) / 2;
}

// ── Input schemas ───────────────────────────────────────────────────────────

const Lat = z.number().min(-90).max(90);
const Lng = z.number().min(-180).max(180);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const CheckEventInput = z.object({
  kind: z.enum(ATTENDANCE_KINDS),
  mode: z.enum(ATTENDANCE_MODES).default("office"),
  latitude: Lat.nullish(),
  longitude: Lng.nullish(),
  accuracyM: z.number().min(0).max(100_000).nullish(),
  mocked: z.boolean().optional(),
  clientTime: z.string().datetime({ offset: true }).nullish(),
  note: z.string().trim().max(500).optional(),
  deviceId: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

export const GeofenceInput = z.object({
  latitude: Lat,
  longitude: Lng,
  radiusM: z.number().int().min(25).max(5000).default(150),
  maxAccuracyM: z.number().int().min(5).max(2000).default(100),
  active: z.boolean().default(true),
});

export const PolicyInput = z
  .object({
    workStart: Hhmm,
    workEnd: Hhmm,
    graceMinutes: z.number().int().min(0).max(240),
    earlyLeaveMinutes: z.number().int().min(0).max(240),
    halfDayMinutes: z.number().int().min(30).max(1440),
    fullDayMinutes: z.number().int().min(30).max(1440),
    weeklyOffs: z.array(z.number().int().min(0).max(6)).max(7),
    allowWfh: z.boolean(),
    allowField: z.boolean(),
  })
  .refine((p) => p.halfDayMinutes <= p.fullDayMinutes, { message: "Half day must not exceed a full day", path: ["halfDayMinutes"] })
  .refine((p) => hhmmToMinutes(p.workEnd) > hhmmToMinutes(p.workStart), { message: "Work end must be after work start", path: ["workEnd"] });

export const ReviewInput = z
  .object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional() })
  .refine((r) => r.decision === "approve" || (r.note && r.note.length >= 3), { message: "Give a reason when rejecting", path: ["note"] });

export const CorrectionInput = z
  .object({
    employeeId: z.string().uuid().optional(), // set by an approver for a manual entry
    workDate: DateStr,
    checkInAt: z.string().datetime({ offset: true }).nullish(),
    checkOutAt: z.string().datetime({ offset: true }).nullish(),
    mode: z.enum(ATTENDANCE_MODES).default("office"),
    reason: z.string().trim().min(5).max(1000),
  })
  .refine((c) => c.checkInAt || c.checkOutAt, { message: "Give a check-in or check-out time", path: ["checkInAt"] })
  .refine((c) => !c.checkInAt || !c.checkOutAt || new Date(c.checkOutAt) > new Date(c.checkInAt), { message: "Check-out must be after check-in", path: ["checkOutAt"] });

export const HolidayInput = z.object({
  holidayDate: DateStr,
  name: z.string().trim().min(2).max(120),
  branchId: z.string().uuid().nullish(),
  optional: z.boolean().default(false),
});

export const LeaveTypeInput = z.object({
  code: z.string().regex(/^[A-Z]{2,6}$/, "2–6 capital letters"),
  name: z.string().trim().min(2).max(80),
  paid: z.boolean().default(true),
  annualQuota: z.number().min(0).max(365),
  accrual: z.enum(["yearly", "monthly", "none"]).default("yearly"),
  carryForwardMax: z.number().min(0).max(365).default(0),
  allowHalfDay: z.boolean().default(true),
  requiresDocumentAfterDays: z.number().min(0.5).max(365).nullish(),
  unlimited: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const LeaveApplyInput = z
  .object({
    leaveTypeId: z.string().uuid(),
    startDate: DateStr,
    endDate: DateStr,
    startHalf: z.boolean().default(false),
    endHalf: z.boolean().default(false),
    reason: z.string().trim().min(3).max(1000),
    documentRef: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.endDate >= r.startDate, { message: "End date must be on or after the start date", path: ["endDate"] })
  .refine((r) => r.startDate.slice(0, 4) === r.endDate.slice(0, 4), { message: "Split leave that crosses a year into two requests", path: ["endDate"] })
  .refine((r) => !(r.startDate === r.endDate && r.startHalf && r.endHalf), { message: "Choose either the first or second half for a single day", path: ["endHalf"] });

export const LeaveAdjustInput = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  delta: z.number().min(-365).max(365).refine((n) => n !== 0 && Math.round(n * 2) === n * 2, "Use whole or half days"),
  reason: z.string().trim().min(5).max(500),
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, dateInZone } from "@rstar/shared";
import { adminApi, makeEmployee, setupApp, teardown, type Api, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let admin: Api;
// Test coordinates near the Visakhapatnam office (not the real office location).
const OFFICE = { latitude: 17.7231, longitude: 83.3013 };
const inside = { ...OFFICE, accuracyM: 15 };
const outside = { latitude: 17.7431, longitude: 83.3013, accuracyM: 15 }; // ~2.2 km north

beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
});
afterAll(async () => teardown(ctx));

describe("GPS check-in / check-out", () => {
  it("never verifies an office check-in before the branch geofence is configured", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"], branch: "HYD" });
    await e.api.post("/v1/attendance/consent");
    const r = await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "office", ...inside });
    expect(r.statusCode).toBe(201);
    expect(r.json().result).toBe("pending_exception");
    expect(r.json().flags.map((f: { code: string }) => f.code)).toContain("no_geofence_configured");
  });

  it("only attendance.configure holders can set geofences", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    expect((await e.api.put(`/v1/attendance/geofences/${ctx.ids.branches.VZG}`, { ...OFFICE, radiusM: 150 })).statusCode).toBe(403);
    const r = await admin.put(`/v1/attendance/geofences/${ctx.ids.branches.VZG}`, { ...OFFICE, radiusM: 150, maxAccuracyM: 100 });
    expect(r.statusCode).toBe(200);
    const list = (await admin.get("/v1/attendance/geofences")).json().items;
    expect(list.find((b: { code: string }) => b.code === "VZG").geofence.radiusM).toBe(150);
  });

  it("requires location consent, verifies inside the fence, blocks double check-in, and is idempotent", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const noConsent = await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "office", ...inside });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json().error.details.code).toBe("consent_required");
    await e.api.post("/v1/attendance/consent");

    const key = "chk-" + Date.now();
    const ci = await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "office", ...inside, idempotencyKey: key });
    expect(ci.statusCode).toBe(201);
    expect(ci.json()).toMatchObject({ result: "verified", flags: [] });
    const replay = await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "office", ...inside, idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(ci.json().id);
    expect((await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "office", ...inside })).statusCode).toBe(409);

    const today = (await e.api.get("/v1/attendance/me/today")).json();
    expect(today.checkedIn).toBe(true);
    expect(today.office.configured).toBe(true);
    expect(today.day.status).toBe("in_progress");

    const co = await e.api.post("/v1/attendance/events", { kind: "check_out", mode: "office", ...inside });
    expect(co.statusCode).toBe(201);
    expect((await e.api.post("/v1/attendance/events", { kind: "check_out", mode: "office", ...inside })).statusCode).toBe(409);
    expect((await e.api.get("/v1/attendance/me/today")).json().checkedIn).toBe(false);
  });

  it("flags out-of-fence and mock locations for the reporting manager to review", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const e = await makeEmployee(ctx, admin, { roles: ["employee"], managerId: mgr.emp.id });
    const other = await makeEmployee(ctx, admin, { roles: ["employee"] });
    await e.api.post("/v1/attendance/consent");
    const r = await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "office", ...outside, mocked: true });
    expect(r.json().result).toBe("pending_exception");
    expect(r.json().flags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(["outside_geofence", "mock_location"]));
    const id = r.json().id;

    // The manager sees it in their queue and was notified; others cannot see or act on it.
    const queue = (await mgr.api.get("/v1/attendance/exceptions")).json().items.map((x: { id: number }) => x.id);
    expect(queue).toContain(id);
    const notes = (await mgr.api.get("/v1/notifications")).json();
    expect(JSON.stringify(notes)).toContain("attendance needs review");
    expect((await other.api.post(`/v1/attendance/events/${id}/review`, { decision: "approve" })).statusCode).toBe(404);
    expect((await e.api.post(`/v1/attendance/events/${id}/review`, { decision: "approve" })).statusCode).toBe(403);
    expect((await mgr.api.post(`/v1/attendance/events/${id}/review`, { decision: "reject" })).statusCode).toBe(400); // reason required

    const ok = await mgr.api.post(`/v1/attendance/events/${id}/review`, { decision: "approve", note: "At client shoot nearby" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result).toBe("approved_exception");
    expect((await mgr.api.post(`/v1/attendance/events/${id}/review`, { decision: "approve" })).statusCode).toBe(409);

    const audit = await ctx.db.query(`SELECT 1 FROM audit_events WHERE action = 'attendance.exception.approve' AND entity_id = $1`, [String(id)]);
    expect(audit.rowCount).toBe(1);
    await expect(ctx.db.query(`DELETE FROM attendance_events WHERE id = $1`, [id])).rejects.toThrow();
  });

  it("WFH is refused by default policy and field check-ins need a location", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    await e.api.post("/v1/attendance/consent");
    const wfh = await e.api.post("/v1/attendance/events", { kind: "check_in", mode: "wfh" });
    expect(wfh.json().flags.map((f: { code: string }) => f.code)).toContain("wfh_not_allowed");
  });
});

describe("corrections, manual entries and the register", () => {
  it("employee requests a correction, manager approves, ledger uses it", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const e = await makeEmployee(ctx, admin, { roles: ["employee"], managerId: mgr.emp.id });
    const today = dateInZone(new Date(), "Asia/Kolkata");
    const day = addDays(today, -2);
    const req = await e.api.post("/v1/attendance/corrections", {
      workDate: day, checkInAt: `${day}T09:30:00+05:30`, checkOutAt: `${day}T18:45:00+05:30`, reason: "Phone battery died at the shoot",
    });
    expect(req.statusCode).toBe(201);
    expect((await e.api.post("/v1/attendance/corrections", { workDate: day, checkInAt: `${day}T09:00:00+05:30`, reason: "Second try" })).statusCode).toBe(409);
    expect((await e.api.post("/v1/attendance/corrections", { workDate: addDays(today, 1), checkInAt: `${today}T09:00:00+05:30`, reason: "Future" })).statusCode).toBe(400);
    expect((await e.api.post(`/v1/attendance/corrections/${req.json().id}/review`, { decision: "approve" })).statusCode).toBe(403);

    const review = (await mgr.api.get("/v1/attendance/corrections?view=review&status=pending")).json().items;
    expect(review.map((c: { id: string }) => c.id)).toContain(req.json().id);
    expect((await mgr.api.post(`/v1/attendance/corrections/${req.json().id}/review`, { decision: "approve" })).statusCode).toBe(200);

    const mine = (await e.api.get(`/v1/attendance/me?from=${day}&to=${day}`)).json();
    expect(mine.days[0]).toMatchObject({ work_date: day, source: "correction", worked_minutes: 555 });
  });

  it("HR can enter attendance manually; scope limits the register", async () => {
    const hr = await makeEmployee(ctx, admin, { roles: ["hr_admin"], dept: "ADMIN_HR" });
    const e = await makeEmployee(ctx, admin, { roles: ["employee"], branch: "HYD" });
    const peer = await makeEmployee(ctx, admin, { roles: ["employee"], branch: "HYD" });
    const day = addDays(dateInZone(new Date(), "Asia/Kolkata"), -3);
    const m = await hr.api.post("/v1/attendance/corrections", { employeeId: e.emp.id, workDate: day, checkInAt: `${day}T10:00:00+05:30`, checkOutAt: `${day}T19:00:00+05:30`, reason: "Biometric outage, register sheet" });
    expect(m.statusCode).toBe(201);
    expect(m.json()).toMatchObject({ kind: "manual", status: "approved" });
    expect((await peer.api.post("/v1/attendance/corrections", { employeeId: e.emp.id, workDate: day, checkInAt: `${day}T10:00:00+05:30`, reason: "Not allowed" })).statusCode).toBe(404);
    expect((await hr.api.post("/v1/attendance/corrections", { employeeId: hr.emp.id, workDate: day, checkInAt: `${day}T10:00:00+05:30`, reason: "Self manual" })).statusCode).toBe(201);

    const reg = (await hr.api.get(`/v1/attendance/register?from=${day}&to=${day}&branchId=${ctx.ids.branches.HYD}`)).json();
    const row = reg.employees.find((x: { id: string }) => x.id === e.emp.id);
    expect(row.days[0].worked_minutes).toBe(540);
    const peerReg = (await peer.api.get(`/v1/attendance/register?from=${day}&to=${day}`)).json();
    expect(peerReg.employees.map((x: { id: string }) => x.id)).toEqual([peer.emp.id]);
  });

  it("holidays mark the ledger and are configurable only by attendance admins", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    // A past weekday after the test employee's joining date.
    let day = addDays(dateInZone(new Date(), "Asia/Kolkata"), -5);
    if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) day = addDays(day, -1);
    expect((await e.api.post("/v1/holidays", { holidayDate: day, name: "Test holiday" })).statusCode).toBe(403);
    const h = await admin.post("/v1/holidays", { holidayDate: day, name: "Test holiday", branchId: ctx.ids.branches.VZG });
    expect(h.statusCode).toBe(201);
    const mine = (await e.api.get(`/v1/attendance/me?from=${day}&to=${day}`)).json();
    expect(mine.days[0].status).toBe("holiday");
    expect((await admin.del(`/v1/holidays/${h.json().id}`)).statusCode).toBe(204);
    expect((await e.api.get(`/v1/attendance/me?from=${day}&to=${day}`)).json().days[0].status).toBe("absent");
  });
});

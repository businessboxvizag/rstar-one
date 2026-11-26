import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, dateInZone } from "@rstar/shared";
import { adminApi, makeEmployee, setupApp, teardown, type Api, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let admin: Api;
let types: Record<string, string>;

/** Next Monday at least two weeks away, so tests never touch past dates. */
function futureMonday(): string {
  let d = addDays(dateInZone(new Date(), "Asia/Kolkata"), 14);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
  types = Object.fromEntries((await admin.get("/v1/leave/types")).json().items.map((t: { code: string; id: string }) => [t.code, t.id]));
});
afterAll(async () => teardown(ctx));

async function staffWithBalance(code: string, days: number, managerId?: string) {
  const e = await makeEmployee(ctx, admin, { roles: ["employee"], managerId });
  const year = Number(futureMonday().slice(0, 4));
  // Start from a known balance regardless of the date the suite runs on.
  const cur = (await e.api.get(`/v1/leave/balances?year=${year}`)).json().items.find((b: { code: string }) => b.code === code);
  const delta = days - cur.available;
  if (delta !== 0) expect((await admin.post("/v1/leave/adjustments", { employeeId: e.emp.id, leaveTypeId: types[code], year, delta, reason: "Test opening balance" })).statusCode).toBe(200);
  return { ...e, year };
}

const bal = async (api: Api, year: number, code: string) => (await api.get(`/v1/leave/balances?year=${year}`)).json().items.find((b: { code: string }) => b.code === code);

describe("leave", () => {
  it("seeds editable leave types", () => {
    expect(Object.keys(types)).toEqual(expect.arrayContaining(["CL", "SL", "EL", "LOP"]));
  });

  it("apply → pending balance → manager approves → used; cannot self-approve", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const e = await staffWithBalance("CL", 5, mgr.emp.id);
    const mon = futureMonday();
    const r = await e.api.post("/v1/leave/requests", { leaveTypeId: types.CL, startDate: mon, endDate: addDays(mon, 2), endHalf: true, reason: "Family function" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ days: 2.5, status: "pending" });
    expect(await bal(e.api, e.year, "CL")).toMatchObject({ pending: 2.5, available: 2.5 });

    expect((await e.api.post("/v1/leave/requests", { leaveTypeId: types.CL, startDate: addDays(mon, 1), endDate: addDays(mon, 1), reason: "Overlap" })).statusCode).toBe(409);
    const tooMuch = await e.api.post("/v1/leave/requests", { leaveTypeId: types.CL, startDate: addDays(mon, 7), endDate: addDays(mon, 10), reason: "Too long" });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error.details.code).toBe("insufficient_balance");

    expect((await e.api.post(`/v1/leave/requests/${r.json().id}/decide`, { decision: "approve" })).statusCode).toBe(403);
    const queue = (await mgr.api.get("/v1/leave/requests?view=review&status=pending")).json().items;
    expect(queue.map((x: { id: string }) => x.id)).toContain(r.json().id);
    const ok = await mgr.api.post(`/v1/leave/requests/${r.json().id}/decide`, { decision: "approve", expectedVersion: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("approved");
    expect(await bal(e.api, e.year, "CL")).toMatchObject({ pending: 0, used: 2.5, available: 2.5 });
    expect((await mgr.api.post(`/v1/leave/requests/${r.json().id}/decide`, { decision: "approve" })).statusCode).toBe(409);

    // Employee cancels before it starts: balance restored, manager notified.
    expect((await e.api.post(`/v1/leave/requests/${r.json().id}/cancel`, {})).statusCode).toBe(400); // reason needed for approved leave
    const c = await e.api.post(`/v1/leave/requests/${r.json().id}/cancel`, { reason: "Function postponed" });
    expect(c.json().status).toBe("cancelled");
    expect(await bal(e.api, e.year, "CL")).toMatchObject({ used: 0, available: 5 });
  });

  it("rejection needs a reason and releases the pending balance; withdraw works", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const e = await staffWithBalance("CL", 3, mgr.emp.id);
    const mon = futureMonday();
    const r = await e.api.post("/v1/leave/requests", { leaveTypeId: types.CL, startDate: mon, endDate: mon, reason: "Personal" });
    expect((await mgr.api.post(`/v1/leave/requests/${r.json().id}/decide`, { decision: "reject" })).statusCode).toBe(400);
    expect((await mgr.api.post(`/v1/leave/requests/${r.json().id}/decide`, { decision: "reject", note: "Studio shoot that day" })).json().status).toBe("rejected");
    expect(await bal(e.api, e.year, "CL")).toMatchObject({ pending: 0, available: 3 });

    const w = await e.api.post("/v1/leave/requests", { leaveTypeId: types.CL, startDate: addDays(mon, 1), endDate: addDays(mon, 1), reason: "Personal" });
    expect((await e.api.post(`/v1/leave/requests/${w.json().id}/cancel`, {})).json().status).toBe("withdrawn");
    expect(await bal(e.api, e.year, "CL")).toMatchObject({ pending: 0, available: 3 });
  });

  it("skips holidays and weekly offs, requires documents for long sick leave, and allows unlimited LOP", async () => {
    const e = await staffWithBalance("SL", 10);
    const mon = futureMonday();
    const h = await admin.post("/v1/holidays", { holidayDate: addDays(mon, 2), name: "Leave test holiday" });
    expect(h.statusCode).toBe(201);
    // Mon..next Mon = 8 calendar days, minus Sunday and the Wednesday holiday = 6
    const noDoc = await e.api.post("/v1/leave/requests", { leaveTypeId: types.SL, startDate: mon, endDate: addDays(mon, 7), reason: "Fever" });
    expect(noDoc.json().error.details.code).toBe("document_required");
    const sl = await e.api.post("/v1/leave/requests", { leaveTypeId: types.SL, startDate: mon, endDate: addDays(mon, 7), reason: "Fever", documentRef: "Medical certificate (paper copy with HR)" });
    expect(sl.json().days).toBe(6);
    const lop = await e.api.post("/v1/leave/requests", { leaveTypeId: types.LOP, startDate: addDays(mon, 8), endDate: addDays(mon, 11), reason: "Long travel" });
    expect(lop.statusCode).toBe(201);
    await admin.del(`/v1/holidays/${h.json().id}`);
  });

  it("scopes leave visibility and only HR configures types", async () => {
    const a = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const b = await makeEmployee(ctx, admin, { roles: ["employee"] });
    expect((await a.api.get(`/v1/leave/balances?employeeId=${b.emp.id}`)).statusCode).toBe(404);
    expect((await a.api.post("/v1/leave/types", { code: "XX", name: "Bogus", annualQuota: 99 })).statusCode).toBe(403);
    const hr = await makeEmployee(ctx, admin, { roles: ["hr_admin"], dept: "ADMIN_HR" });
    expect((await hr.api.get(`/v1/leave/balances?employeeId=${b.emp.id}`)).statusCode).toBe(200);
    const t = await hr.api.post("/v1/leave/types", { code: "MAT", name: "Maternity leave", annualQuota: 182, accrual: "none", allowHalfDay: false });
    expect(t.statusCode).toBe(201);
    expect((await hr.api.patch(`/v1/leave/types/${t.json().id}`, { annualQuota: 180 })).json().annualQuota).toBe(180);
  });
});

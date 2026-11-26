import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminApi, makeEmployee, setupApp, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => teardown(ctx));

describe("audit log", () => {
  it("records employee creation without storing passwords", async () => {
    const admin = await adminApi(ctx);
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const r = (await admin.get(`/v1/audit?entityType=employee&entityId=${e.emp.id}`)).json();
    const ev = r.items.find((x: { action: string }) => x.action === "employee.create");
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).not.toContain(e.password);
  });

  it("is append-only at the database level", async () => {
    await expect(ctx.db.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(ctx.db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
  });

  it("is readable only with audit.read", async () => {
    const admin = await adminApi(ctx);
    const hr = await makeEmployee(ctx, admin, { roles: ["hr_admin"] });
    expect((await hr.api.get("/v1/audit")).statusCode).toBe(403);
  });

  it("records failed logins", async () => {
    const admin = await adminApi(ctx);
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: e.email, password: "wrong-pass-1" } });
    const r = (await admin.get(`/v1/audit?action=auth.login_failed&entityId=${e.userId}`)).json();
    expect(r.items.length).toBe(1);
  });
});

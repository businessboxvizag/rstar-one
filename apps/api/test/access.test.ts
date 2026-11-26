import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminApi, client, login, makeEmployee, setupApp, teardown, totpNow, type Api, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let admin: Api;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
});
afterAll(async () => teardown(ctx));

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

describe("reset access", () => {
  it("clears a lost authenticator, signs the person out and lets them choose a new password", async () => {
    const u = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const setup = (await u.api.post("/v1/auth/mfa/setup")).json();
    expect((await u.api.post("/v1/auth/mfa/confirm", { totp: totpNow(setup.secret) })).statusCode).toBe(200);

    const r = await admin.post(`/v1/employees/${u.emp.id}/reset-access`);
    expect(r.statusCode).toBe(200);
    expect(r.json().resetUrl).toMatch(/\/reset-password\?token=/);
    expect((await u.api.get("/v1/me")).statusCode).toBe(401);

    const ok = await ctx.app.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token: tokenOf(r.json().resetUrl), newPassword: "FreshStart2026" } });
    expect(ok.statusCode).toBe(200);
    // No authenticator code needed any more; they can enrol again.
    const t = await login(ctx.app, u.email, "FreshStart2026");
    const me = (await client(ctx.app, t.accessToken).get("/v1/me")).json();
    expect(me.security.mfaEnabled).toBe(false);
  });

  it("activates someone whose invitation expired", async () => {
    const email = `invitee.${Date.now()}@test.local`;
    const c = await admin.post("/v1/employees", {
      fullName: "Late Joiner", email, branchId: ctx.ids.branches.VZG, departmentId: ctx.ids.departments.EDIT, joiningDate: "2026-01-05", roleKeys: ["employee"],
    });
    expect(c.statusCode).toBe(201);
    const r = await admin.post(`/v1/employees/${c.json().id}/reset-access`);
    await ctx.app.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token: tokenOf(r.json().resetUrl), newPassword: "JoinedLate2026" } });
    expect((await login(ctx.app, email, "JoinedLate2026")).accessToken).toBeTruthy();
  });

  it("only a Super Admin can reset a privileged account, and nobody resets their own", async () => {
    const hr = await makeEmployee(ctx, admin, { roles: ["hr_admin"] });
    const own = (await ctx.db.query("SELECT id FROM employees WHERE email = 'owner@test.local'")).rows[0];
    expect((await hr.api.post(`/v1/employees/${own.id}/reset-access`)).statusCode).toBe(403);
    expect((await admin.post(`/v1/employees/${own.id}/reset-access`)).statusCode).toBe(400);
  });
});

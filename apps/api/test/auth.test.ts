import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, adminApi, client, login, makeEmployee, setupApp, teardown, totpNow, type TestCtx } from "./helpers.js";
import type { MemoryMailer } from "../src/lib/mailer.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(async () => teardown(ctx));

describe("authentication", () => {
  it("logs in the seeded admin and returns /me with permissions", async () => {
    const api = await adminApi(ctx);
    const me = (await api.get("/v1/me")).json();
    expect(me.user.email).toBe(ADMIN.email);
    expect(me.roles).toContain("super_admin");
    expect(me.permissions["users.manage"]).toBe("org");
    expect(me.security.mustChangePassword).toBe(true);
    expect(me.organisation.productName).toBe("RSTAR ONE");
  });

  it("rejects wrong passwords and unknown users with the same message", async () => {
    const a = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: ADMIN.email, password: "wrong-password-1" } });
    const b = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "nobody@test.local", password: "wrong-password-1" } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
  });

  it("locks an account after 5 failed attempts", async () => {
    const admin = await adminApi(ctx);
    const u = await makeEmployee(ctx, admin, { roles: ["employee"] });
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: u.email, password: "bad-password-9" } });
    }
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: u.email, password: u.password } });
    expect(r.statusCode).toBe(423);
  });

  it("requires a token and rejects garbage tokens", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    expect((await client(ctx.app, "not-a-jwt").get("/v1/me")).statusCode).toBe(401);
  });

  it("rotates refresh tokens and revokes on logout", async () => {
    const t = await login(ctx.app, ADMIN.email, ADMIN.password);
    const r1 = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: t.refreshToken } });
    expect(r1.statusCode).toBe(200);
    // The old refresh token is no longer valid after rotation.
    const again = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: t.refreshToken } });
    expect(again.statusCode).toBe(401);
    const api = client(ctx.app, r1.json().accessToken);
    expect((await api.post("/v1/auth/logout")).statusCode).toBe(200);
    expect((await api.get("/v1/me")).statusCode).toBe(401);
  });

  it("invites an employee without a password and lets them set one", async () => {
    const admin = await adminApi(ctx);
    const r = await admin.post("/v1/employees", {
      fullName: "Invited Person",
      email: "invited@test.local",
      branchId: ctx.ids.branches.HYD,
      departmentId: ctx.ids.departments.CAMERA,
      joiningDate: "2026-02-01",
      roleKeys: ["camera_operator"],
    });
    expect(r.statusCode).toBe(201);
    const { inviteUrl } = r.json();
    expect(inviteUrl).toMatch(/accept-invite\?token=/);
    expect((ctx.app.mailer as MemoryMailer).outbox.some((m) => m.to === "invited@test.local")).toBe(true);
    // Cannot log in before accepting.
    const before = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "invited@test.local", password: "anything123" } });
    expect(before.statusCode).toBe(401);
    const token = new URL(inviteUrl).searchParams.get("token");
    const acc = await ctx.app.inject({ method: "POST", url: "/v1/auth/invite/accept", payload: { token, newPassword: "CameraPass2026" } });
    expect(acc.statusCode).toBe(200);
    await login(ctx.app, "invited@test.local", "CameraPass2026");
    // Token is single-use.
    const reuse = await ctx.app.inject({ method: "POST", url: "/v1/auth/invite/accept", payload: { token, newPassword: "CameraPass2027" } });
    expect(reuse.statusCode).toBe(400);
  });

  it("resets a password through the emailed link without revealing whether accounts exist", async () => {
    const admin = await adminApi(ctx);
    const u = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const mailer = ctx.app.mailer as MemoryMailer;
    const n = mailer.outbox.length;
    const unknown = await ctx.app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email: "ghost@test.local" } });
    expect(unknown.statusCode).toBe(202);
    expect(mailer.outbox.length).toBe(n);
    const known = await ctx.app.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email: u.email } });
    expect(known.statusCode).toBe(202);
    const mail = mailer.outbox[mailer.outbox.length - 1]!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    const ok = await ctx.app.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token, newPassword: "BrandNewPass9" } });
    expect(ok.statusCode).toBe(200);
    // Existing sessions were revoked by the reset.
    expect((await u.api.get("/v1/me")).statusCode).toBe(401);
    await login(ctx.app, u.email, "BrandNewPass9");
  });

  it("enrols in TOTP MFA and then requires the code at login", async () => {
    const admin = await adminApi(ctx);
    const u = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const setup = (await u.api.post("/v1/auth/mfa/setup")).json();
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await u.api.post("/v1/auth/mfa/confirm", { totp: "000000" })).statusCode).toBe(400);
    expect((await u.api.post("/v1/auth/mfa/confirm", { totp: totpNow(setup.secret) })).statusCode).toBe(200);
    const noCode = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: u.email, password: u.password } });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error.code).toBe("mfa_required");
    await login(ctx.app, u.email, u.password, totpNow(setup.secret));
  });
});

describe("MFA enforcement for privileged roles", () => {
  let strict: TestCtx;
  beforeAll(async () => {
    strict = await setupApp({ MFA_ENFORCEMENT: "on" });
  });
  afterAll(async () => {
    // The admin account is shared by other test files: undo the enrolment.
    await strict.db.query("UPDATE users SET mfa_enabled_at = NULL, mfa_secret_enc = NULL WHERE email = $1", [ADMIN.email]);
    await teardown(strict);
  });

  it("withholds sensitive permissions until a privileged user enrols", async () => {
    const t = await login(strict.app, ADMIN.email, ADMIN.password);
    const api = client(strict.app, t.accessToken);
    const me = (await api.get("/v1/me")).json();
    expect(me.security.mfaEnrollmentPending).toBe(true);
    expect(me.permissions["users.manage"]).toBeUndefined();
    const denied = await api.get("/v1/audit");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/two-factor/i);

    const setup = (await api.post("/v1/auth/mfa/setup")).json();
    await api.post("/v1/auth/mfa/confirm", { totp: totpNow(setup.secret) });
    expect((await api.get("/v1/audit")).statusCode).toBe(200);
  });
});

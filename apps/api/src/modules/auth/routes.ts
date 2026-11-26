import type { FastifyInstance } from "fastify";
import {
  ChangePasswordInput,
  LoginInput,
  MfaConfirmInput,
  RefreshInput,
  ResetConfirmInput,
  ResetRequestInput,
  DEFAULT_PRODUCT_NAME,
} from "@rstar/shared";
import { z } from "zod";
import { parse, reqMeta } from "../../app.js";
import { audit } from "../../lib/audit.js";
import { decrypt, encrypt, hashPassword, newTotpSecret, randomToken, sha256, verifyPassword, verifyTotp } from "../../lib/crypto.js";
import { HttpError, badRequest, unauthorized } from "../../errors.js";
import { withTx } from "../../db.js";
import { consumeOneTimeToken, createSession, issueOneTimeToken } from "./service.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/** Seconds a just-rotated refresh token remains usable (concurrent refreshes from two tabs). */
const REFRESH_GRACE_SECONDS = 20;

export async function authRoutes(app: FastifyInstance) {
  const loginLimit = {
    config: {
      rateLimit: {
        max: app.config.LOGIN_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
        keyGenerator: (req: { ip: string; body?: unknown }) =>
          `${req.ip}:${String((req.body as { email?: string } | undefined)?.email ?? "").toLowerCase()}`,
      },
    },
  };

  app.post("/auth/login", loginLimit, async (req) => {
    const body = parse(LoginInput, req.body);
    const meta = reqMeta(req);
    const rows = (
      await app.db.query(
        `SELECT id, organisation_id, password_hash, status, failed_logins, locked_until, mfa_secret_enc, mfa_enabled_at
           FROM users WHERE email = $1`,
        [body.email],
      )
    ).rows;
    const u = rows.length === 1 ? rows[0] : undefined;
    const ok = await verifyPassword(body.password, u?.password_hash ?? null);

    if (!u) throw unauthorized("Invalid email or password");
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new HttpError(423, "locked", "Too many failed attempts. Try again later or reset your password.");
    }
    if (!ok || u.status !== "active") {
      const failed = u.failed_logins + 1;
      await app.db.query(
        `UPDATE users SET failed_logins = $2::int,
            locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END
          WHERE id = $1`,
        [u.id, failed, MAX_FAILED, LOCK_MINUTES],
      );
      await audit(app.db, { orgId: u.organisation_id, actorUserId: u.id, action: "auth.login_failed", entityType: "user", entityId: u.id, after: { failed }, ...meta });
      throw unauthorized("Invalid email or password");
    }
    if (u.mfa_enabled_at) {
      if (!body.totp) throw new HttpError(401, "mfa_required", "Enter the 6-digit code from your authenticator app");
      const secret = decrypt(u.mfa_secret_enc, app.config.DATA_ENCRYPTION_KEY);
      if (!verifyTotp(secret, body.totp)) {
        await audit(app.db, { orgId: u.organisation_id, actorUserId: u.id, action: "auth.mfa_failed", entityType: "user", entityId: u.id, ...meta });
        throw new HttpError(401, "mfa_invalid", "That code is not valid");
      }
    }
    await app.db.query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [u.id]);
    const session = await createSession(app, u.id, u.organisation_id, { ip: req.ip, userAgent: meta.userAgent });
    await audit(app.db, { orgId: u.organisation_id, actorUserId: u.id, action: "auth.login", entityType: "session", entityId: session.sessionId, ...meta });
    return session;
  });

  app.post("/auth/refresh", async (req) => {
    const { refreshToken } = parse(RefreshInput, req.body);
    const presented = sha256(refreshToken);
    const next = randomToken(32);
    const r = await app.db.query<{ id: string; user_id: string; organisation_id: string }>(
      `UPDATE sessions s SET previous_token_hash = s.refresh_token_hash, rotated_at = now(), refresh_token_hash = $2, last_used_at = now()
         FROM users u
        WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.id = s.user_id AND u.status = 'active'
        RETURNING s.id, s.user_id, u.organisation_id`,
      [presented, sha256(next)],
    );
    let s = r.rows[0];
    let rotated = true;
    if (!s) {
      // Previous token: inside the grace window it yields an access token only; outside it, it is
      // treated as a replayed (possibly stolen) token and the whole session is revoked.
      const prev = (
        await app.db.query<{ id: string; user_id: string; organisation_id: string; in_grace: boolean }>(
          `SELECT s.id, s.user_id, u.organisation_id, (s.rotated_at > now() - make_interval(secs => $2)) AS in_grace
             FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.previous_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
          [presented, REFRESH_GRACE_SECONDS],
        )
      ).rows[0];
      if (prev && !prev.in_grace) {
        await app.db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [prev.id]);
        await audit(app.db, { orgId: prev.organisation_id, actorUserId: prev.user_id, action: "auth.refresh_reuse_revoked", entityType: "session", entityId: prev.id, ...reqMeta(req) });
      }
      if (!prev?.in_grace) throw unauthorized("Session expired");
      s = prev;
      rotated = false;
    }
    const accessToken = await app.tokens.sign({ sub: s.user_id, sid: s.id, org: s.organisation_id });
    return { accessToken, refreshToken: rotated ? next : null, expiresIn: app.config.ACCESS_TOKEN_TTL_SECONDS, sessionId: s.id };
  });

  app.post("/auth/logout", { preHandler: app.authenticate }, async (req) => {
    await app.db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [req.principal.sessionId]);
    await audit(app.db, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "auth.logout", entityType: "session", entityId: req.principal.sessionId, ...reqMeta(req) });
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticate }, async (req) => {
    const p = req.principal;
    const org = (await app.db.query("SELECT product_name, partner_label FROM organisations WHERE id = $1", [p.orgId])).rows[0];
    return {
      user: { id: p.userId, email: p.email, displayName: p.displayName, kind: p.kind, employeeId: p.employeeId, branchId: p.branchId, departmentId: p.departmentId, clientId: p.clientId },
      roles: p.roleKeys,
      permissions: p.grants,
      security: { mfaEnabled: p.mfaEnabled, mfaRequired: p.mfaRequired, mfaEnrollmentPending: p.mfaEnrollmentPending, mustChangePassword: p.mustChangePassword },
      organisation: { productName: org?.product_name ?? DEFAULT_PRODUCT_NAME, partnerLabel: org?.partner_label },
    };
  });

  app.get("/me/sessions", { preHandler: app.authenticate }, async (req) => {
    const r = await app.db.query(
      `SELECT id, user_agent, ip, created_at, last_used_at, expires_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`,
      [req.principal.userId],
    );
    return { items: r.rows.map((s) => ({ ...s, current: s.id === req.principal.sessionId })) };
  });

  app.delete("/me/sessions/:id", { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await app.db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2", [id, req.principal.userId]);
    return { ok: true };
  });

  app.post("/auth/password", { preHandler: app.authenticate }, async (req) => {
    const body = parse(ChangePasswordInput, req.body);
    const p = req.principal;
    const u = (await app.db.query("SELECT password_hash FROM users WHERE id = $1", [p.userId])).rows[0];
    if (!(await verifyPassword(body.currentPassword, u?.password_hash ?? null))) throw badRequest("Current password is incorrect");
    await withTx(app.db, async (tx) => {
      await tx.query("UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1", [p.userId, await hashPassword(body.newPassword)]);
      await tx.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [p.userId, p.sessionId]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "auth.password_changed", entityType: "user", entityId: p.userId, ...reqMeta(req) });
    });
    return { ok: true };
  });

  // ── MFA (TOTP) ──
  app.post("/auth/mfa/setup", { preHandler: app.authenticate }, async (req) => {
    const p = req.principal;
    if (p.mfaEnabled) throw badRequest("Two-factor authentication is already enabled");
    const secret = newTotpSecret();
    await app.db.query("UPDATE users SET mfa_secret_enc = $2 WHERE id = $1", [p.userId, encrypt(secret, app.config.DATA_ENCRYPTION_KEY)]);
    const org = (await app.db.query("SELECT product_name FROM organisations WHERE id = $1", [p.orgId])).rows[0];
    const issuer = encodeURIComponent(org?.product_name ?? DEFAULT_PRODUCT_NAME);
    return { secret, otpauthUrl: `otpauth://totp/${issuer}:${encodeURIComponent(p.email)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
  });

  app.post("/auth/mfa/confirm", { preHandler: app.authenticate }, async (req) => {
    const { totp } = parse(MfaConfirmInput, req.body);
    const p = req.principal;
    const u = (await app.db.query("SELECT mfa_secret_enc, mfa_enabled_at FROM users WHERE id = $1", [p.userId])).rows[0];
    if (!u?.mfa_secret_enc || u.mfa_enabled_at) throw badRequest("Start two-factor setup first");
    if (!verifyTotp(decrypt(u.mfa_secret_enc, app.config.DATA_ENCRYPTION_KEY), totp)) throw badRequest("That code is not valid");
    await app.db.query("UPDATE users SET mfa_enabled_at = now() WHERE id = $1", [p.userId]);
    await audit(app.db, { orgId: p.orgId, actorUserId: p.userId, action: "auth.mfa_enabled", entityType: "user", entityId: p.userId, ...reqMeta(req) });
    return { ok: true };
  });

  // ── Invitations & password reset ──
  app.post("/auth/invite/accept", loginLimit, async (req) => {
    const body = parse(ResetConfirmInput, req.body);
    const userId = await withTx(app.db, async (tx) => {
      const id = await consumeOneTimeToken(tx, body.token, "invite");
      if (!id) throw badRequest("This invitation link is invalid or has expired");
      const u = (
        await tx.query(
          `UPDATE users SET password_hash = $2, status = 'active', must_change_password = false WHERE id = $1 AND status = 'invited'
           RETURNING organisation_id`,
          [id, await hashPassword(body.newPassword)],
        )
      ).rows[0];
      if (!u) throw badRequest("This invitation has already been used");
      await audit(tx, { orgId: u.organisation_id, actorUserId: id, action: "auth.invite_accepted", entityType: "user", entityId: id, ...reqMeta(req) });
      return id;
    });
    return { ok: true, userId };
  });

  app.post("/auth/password-reset/request", loginLimit, async (req, reply) => {
    const { email } = parse(ResetRequestInput, req.body);
    const u = (await app.db.query("SELECT id, organisation_id FROM users WHERE email = $1 AND status = 'active'", [email])).rows;
    if (u.length === 1) {
      const token = await issueOneTimeToken(app.db, u[0].id, "password_reset", 1);
      await app.mailer.send({
        to: email,
        subject: "Reset your password",
        text: `Use this link within 1 hour to reset your password: ${app.config.APP_BASE_URL}/reset-password?token=${token}\nIf you did not ask for this, ignore this email.`,
      });
      await audit(app.db, { orgId: u[0].organisation_id, actorUserId: null, action: "auth.password_reset_requested", entityType: "user", entityId: u[0].id, ...reqMeta(req) });
    }
    // Same response whether or not the account exists (no account enumeration).
    return reply.status(202).send({ ok: true });
  });

  app.post("/auth/password-reset/confirm", loginLimit, async (req) => {
    const body = parse(ResetConfirmInput, req.body);
    await withTx(app.db, async (tx) => {
      const id = await consumeOneTimeToken(tx, body.token, "password_reset");
      if (!id) throw badRequest("This reset link is invalid or has expired");
      const u = (
        await tx.query(
          `UPDATE users SET password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = NULL,
                  status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
            WHERE id = $1 RETURNING organisation_id`,
          [id, await hashPassword(body.newPassword)],
        )
      ).rows[0];
      await tx.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      await audit(tx, { orgId: u.organisation_id, actorUserId: id, action: "auth.password_reset", entityType: "user", entityId: id, ...reqMeta(req) });
    });
    return { ok: true };
  });
}

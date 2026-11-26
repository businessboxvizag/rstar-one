/**
 * Break-glass: turn off two-factor sign-in for one user who lost their authenticator app.
 *
 *   MFA_RESET_EMAIL=<email> MFA_RESET_BEFORE=<ISO time>
 *
 * Runs during deploys. It only clears 2FA that was set up at or before MFA_RESET_BEFORE,
 * so the user can enrol again right away and later deploys never undo the new enrolment.
 * All sessions of the user are revoked and the change is written to the audit log.
 * Where the user's role requires 2FA, they are asked to set it up again at next sign-in.
 */
import { createPool } from "../db.js";

const url = process.env.DATABASE_URL;
const email = process.env.MFA_RESET_EMAIL?.trim().toLowerCase();
const beforeRaw = process.env.MFA_RESET_BEFORE?.trim();
if (!url) throw new Error("DATABASE_URL is not set");
if (!email || !beforeRaw) {
  console.log("[reset-mfa] MFA_RESET_EMAIL or MFA_RESET_BEFORE not set; nothing to do.");
  process.exit(0);
}
const before = new Date(beforeRaw);
if (Number.isNaN(before.getTime())) {
  console.error("[reset-mfa] MFA_RESET_BEFORE is not a valid date/time.");
  process.exit(1);
}

const db = createPool(url, 1);
try {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const u = (
      await client.query(
        `SELECT id, organisation_id FROM users
          WHERE email = $1 AND (mfa_secret_enc IS NOT NULL OR mfa_enabled_at IS NOT NULL)
            AND (mfa_enabled_at IS NULL OR mfa_enabled_at <= $2) FOR UPDATE`,
        [email, before.toISOString()],
      )
    ).rows;
    if (!u.length) {
      console.log("[reset-mfa] no matching 2FA enrolment to clear; skipping (already reset?).");
      await client.query("ROLLBACK");
    } else {
      for (const row of u) {
        await client.query("UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL WHERE id = $1", [row.id]);
        await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [row.id]);
        await client.query(
          `INSERT INTO audit_events (organisation_id, actor_user_id, action, entity_type, entity_id, before, after)
           VALUES ($1, NULL, 'auth.mfa_reset', 'user', $2, $3, $4)`,
          [row.organisation_id, row.id, JSON.stringify({ mfaEnabled: true }), JSON.stringify({ mfaEnabled: false, via: "break-glass" })],
        );
      }
      await client.query("COMMIT");
      console.log(`[reset-mfa] 2FA cleared for ${email}; sessions revoked.`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
} finally {
  await db.end();
}

/**
 * Break-glass: move the seeded Super Admin to a new sign-in email and password.
 *
 *   ADMIN_RENAME_FROM=<current email> SEED_ADMIN_EMAIL=<new email> SEED_ADMIN_PASSWORD=<new password>
 *
 * Runs before the seed during deploys. It only acts while a user with the old email exists,
 * so later deploys never reset the password again. All sessions of the user are revoked and
 * the change is written to the audit log. MFA enrolment is left as it is (still enforced).
 */
import { PasswordPolicy } from "@rstar/shared";
import { createPool } from "../db.js";
import { hashPassword } from "../lib/crypto.js";

const url = process.env.DATABASE_URL;
const from = process.env.ADMIN_RENAME_FROM?.trim().toLowerCase();
const to = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD ?? "";
if (!url) throw new Error("DATABASE_URL is not set");
if (!from || !to) {
  console.log("[rename-admin] ADMIN_RENAME_FROM or SEED_ADMIN_EMAIL not set; nothing to do.");
  process.exit(0);
}
if (!PasswordPolicy.safeParse(password).success) {
  console.error("[rename-admin] SEED_ADMIN_PASSWORD does not meet the password policy.");
  process.exit(1);
}

const db = createPool(url, 1);
try {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const u = (
      await client.query(
        `SELECT u.id, u.organisation_id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.key = 'super_admin'
          WHERE u.email = $1 FOR UPDATE OF u`,
        [from],
      )
    ).rows[0];
    if (!u) {
      console.log(`[rename-admin] no Super Admin with the old email; skipping (already moved?).`);
      await client.query("ROLLBACK");
    } else {
      const clash = (await client.query("SELECT 1 FROM users WHERE organisation_id = $1 AND email = $2", [u.organisation_id, to])).rowCount;
      if (clash && from !== to) throw new Error("the new email is already used by another user");
      await client.query(
        "UPDATE users SET email = $2, password_hash = $3, must_change_password = false, failed_logins = 0, locked_until = NULL WHERE id = $1",
        [u.id, to, await hashPassword(password)],
      );
      await client.query("UPDATE employees SET email = $2 WHERE user_id = $1", [u.id, to]);
      await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
      await client.query(
        `INSERT INTO audit_events (organisation_id, actor_user_id, action, entity_type, entity_id, before, after)
         VALUES ($1, NULL, 'auth.admin_moved', 'user', $2, $3, $4)`,
        [u.organisation_id, u.id, JSON.stringify({ email: from }), JSON.stringify({ email: to, passwordReset: true })],
      );
      await client.query("COMMIT");
      console.log(`[rename-admin] Super Admin moved to ${to}; password set and sessions revoked.`);
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

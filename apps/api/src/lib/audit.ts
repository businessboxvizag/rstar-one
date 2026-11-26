import type { Queryable } from "../db.js";

export interface AuditInput {
  orgId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Keys that must never be written to the audit log in clear text. */
const REDACT = new Set(["password", "password_hash", "passwordHash", "initialPassword", "mfa_secret_enc", "token", "refreshToken", "data_enc"]);

function redact(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (Array.isArray(v)) return v.map(redact);
  if (typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, REDACT.has(k) ? "[redacted]" : redact(x)]));
  }
  return v;
}

/** Append an audit event. Call with the transaction client so it commits atomically with the change. */
export async function audit(q: Queryable, e: AuditInput): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (organisation_id, actor_user_id, action, entity_type, entity_id, before, after, ip, user_agent, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      e.orgId,
      e.actorUserId,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(redact(e.before)),
      e.after === undefined ? null : JSON.stringify(redact(e.after)),
      e.ip ?? null,
      e.userAgent?.slice(0, 400) ?? null,
      e.requestId ?? null,
    ],
  );
}

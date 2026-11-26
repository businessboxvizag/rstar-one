import {
  PERMISSIONS,
  scopeRank,
  widerScope,
  type Grants,
  type PermissionKey,
  type Scope,
} from "@rstar/shared";
import type { Queryable } from "../db.js";
import { forbidden } from "../errors.js";

const SENSITIVE = new Set<string>(PERMISSIONS.filter((p) => "sensitive" in p && p.sensitive).map((p) => p.key));

/** Everything the server knows about the caller, loaded fresh on each request. */
export interface Principal {
  userId: string;
  orgId: string;
  sessionId: string;
  kind: "staff" | "client";
  email: string;
  displayName: string;
  clientId: string | null;
  employeeId: string | null;
  branchId: string | null;
  departmentId: string | null;
  roleKeys: string[];
  grants: Grants;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  /** True when a privileged user has not enrolled in MFA: sensitive grants are withheld until they do. */
  mfaEnrollmentPending: boolean;
  mustChangePassword: boolean;
}

export async function loadPrincipal(
  q: Queryable,
  userId: string,
  sessionId: string,
  opts: { mfaEnforcement: boolean },
): Promise<Principal | null> {
  const u = (
    await q.query(
      `SELECT u.id, u.organisation_id, u.kind, u.email, u.display_name, u.client_id, u.status,
              u.mfa_enabled_at, u.must_change_password,
              e.id AS employee_id, e.branch_id, e.department_id, e.status AS employee_status
         FROM users u LEFT JOIN employees e ON e.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    )
  ).rows[0];
  if (!u || u.status !== "active") return null;
  if (u.employee_status === "exited" || u.employee_status === "archived") return null;

  const roles = (
    await q.query(
      `SELECT r.key, r.audience, r.mfa_required, rp.permission_key, rp.scope
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.active
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ur.user_id = $1`,
      [userId],
    )
  ).rows as { key: string; audience: string; mfa_required: boolean; permission_key: string | null; scope: Scope | null }[];

  const roleKeys = [...new Set(roles.map((r) => r.key))];
  const mfaRequired = roles.some((r) => r.mfa_required);
  const grants: Grants = {};
  // Staff base grants are stored on the "employee" role and every staff user holds it implicitly.
  if (u.kind === "staff") {
    const base = await q.query(
      `SELECT rp.permission_key, rp.scope FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organisation_id = $1 AND r.key = 'employee_base'`,
      [u.organisation_id],
    );
    for (const r of base.rows) grants[r.permission_key as PermissionKey] = r.scope;
  }
  for (const r of roles) {
    if (!r.permission_key || !r.scope) continue;
    // A client user can never receive staff permissions even through a misconfigured role.
    if (u.kind === "client" && r.audience !== "client") continue;
    const k = r.permission_key as PermissionKey;
    grants[k] = widerScope(grants[k] ?? null, r.scope) ?? r.scope;
  }

  const mfaEnabled = Boolean(u.mfa_enabled_at);
  const mfaEnrollmentPending = opts.mfaEnforcement && mfaRequired && !mfaEnabled;
  if (mfaEnrollmentPending) for (const k of Object.keys(grants)) if (SENSITIVE.has(k)) delete grants[k as PermissionKey];

  return {
    userId: u.id,
    orgId: u.organisation_id,
    sessionId,
    kind: u.kind,
    email: u.email,
    displayName: u.display_name,
    clientId: u.client_id,
    employeeId: u.employee_id,
    branchId: u.branch_id,
    departmentId: u.department_id,
    roleKeys,
    grants,
    mfaEnabled,
    mfaRequired,
    mfaEnrollmentPending,
    mustChangePassword: u.must_change_password,
  };
}

export function scopeOf(p: Principal, key: PermissionKey): Scope | null {
  return p.grants[key] ?? null;
}

/** Throws 403 unless the principal holds `key` at `min` scope or wider. Returns the scope held. */
export function requirePermission(p: Principal, key: PermissionKey, min: Scope = "own"): Scope {
  const s = scopeOf(p, key);
  if (!s || scopeRank(s) < scopeRank(min)) {
    throw forbidden(p.mfaEnrollmentPending ? "Set up two-factor authentication to use this feature" : undefined);
  }
  return s;
}

/** Facts about a record needed to decide if a scope covers it. */
export interface ScopedRecord {
  branchId: string | null;
  departmentId: string | null;
  /** Users directly responsible for the record (owner, assignees, creator, the employee themself). */
  userIds: string[];
  /** Reporting managers (user ids) of the people in userIds — used by "team" scope. */
  managerUserIds?: string[];
  clientId?: string | null;
}

export function scopeCovers(p: Principal, scope: Scope, rec: ScopedRecord): boolean {
  if (p.kind === "client") return Boolean(p.clientId && rec.clientId === p.clientId);
  // A wider scope always includes everything the narrower scopes would.
  const own = rec.userIds.includes(p.userId);
  const team = own || (rec.managerUserIds ?? []).includes(p.userId);
  switch (scope) {
    case "org":
      return true;
    case "branch":
      return team || (rec.branchId !== null && rec.branchId === p.branchId);
    case "department":
      return team || (rec.departmentId !== null && rec.departmentId === p.departmentId);
    case "team":
      return team;
    case "own":
      return own;
  }
}

export function requireOnRecord(p: Principal, key: PermissionKey, rec: ScopedRecord): void {
  const s = scopeOf(p, key);
  if (!s || !scopeCovers(p, s, rec)) throw forbidden();
}

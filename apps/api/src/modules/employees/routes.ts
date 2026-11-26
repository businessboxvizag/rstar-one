import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AssignRolesInput, CreateEmployeeInput, Pagination, UpdateEmployeeInput, EMPLOYMENT_STATUSES, type Scope } from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requirePermission, scopeOf, type Principal } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { decrypt, encrypt, hashPassword } from "../../lib/crypto.js";
import { withTx, type Tx } from "../../db.js";
import { badRequest, forbidden, notFound } from "../../errors.js";
import { issueOneTimeToken } from "../auth/service.js";

const IdParam = z.object({ id: z.string().uuid() });

const PUBLIC_COLS = `e.id, e.user_id, e.employee_code, e.full_name, e.email, e.phone, e.branch_id, e.department_id, e.team_id,
  e.designation_id, e.reporting_manager_id, e.employment_type, e.status, e.joining_date, e.probation_end_date, e.exit_date,
  e.skills, e.created_at, e.updated_at, b.name AS branch_name, d.name AS department_name, g.name AS designation_name,
  m.full_name AS reporting_manager_name, u.status AS account_status`;

const FROM = `FROM employees e
  JOIN branches b ON b.id = e.branch_id
  JOIN departments d ON d.id = e.department_id
  JOIN users u ON u.id = e.user_id
  LEFT JOIN designations g ON g.id = e.designation_id
  LEFT JOIN employees m ON m.id = e.reporting_manager_id`;

/** SQL predicate restricting employees to what `scope` allows. Pushes params onto `params`. */
export function employeeScopeSql(p: Principal, scope: Scope, params: unknown[]): string {
  if (scope === "org") return "TRUE";
  params.push(p.userId);
  const me = `$${params.length}`;
  const own = `e.user_id = ${me}`;
  const team = `(${own} OR m.user_id = ${me})`;
  switch (scope) {
    case "branch":
      params.push(p.branchId);
      return `(${team} OR e.branch_id = $${params.length})`;
    case "department":
      params.push(p.departmentId);
      return `(${team} OR e.department_id = $${params.length})`;
    case "team":
      return team;
    case "own":
      return own;
  }
}

async function loadScoped(app: FastifyInstance, p: Principal, id: string) {
  const scope = scopeOf(p, "employees.read");
  if (!scope) throw forbidden();
  const params: unknown[] = [id, p.orgId];
  const where = employeeScopeSql(p, scope, params);
  const r = await app.db.query(`SELECT ${PUBLIC_COLS} ${FROM} WHERE e.id = $1 AND e.organisation_id = $2 AND ${where}`, params);
  // 404 rather than 403 so out-of-scope records are not disclosed.
  if (!r.rows[0]) throw notFound("Employee");
  return r.rows[0];
}

/**
 * HR may assign only roles that do not require MFA (non-privileged).
 * Assigning privileged roles additionally needs roles.manage (Super Admin).
 */
async function resolveRoles(tx: Tx, p: Principal, keys: string[]) {
  if (keys.includes("employee_base")) throw badRequest("The base employee role is applied automatically");
  const r = await tx.query(`SELECT id, key, audience, mfa_required FROM roles WHERE organisation_id = $1 AND key = ANY($2) AND active`, [p.orgId, keys]);
  if (r.rows.length !== new Set(keys).size) throw badRequest("One or more roles do not exist");
  if (r.rows.some((x) => x.audience !== "staff")) throw badRequest("Client roles cannot be given to employees");
  if (r.rows.some((x) => x.mfa_required) && !scopeOf(p, "roles.manage")) {
    throw forbidden("Only a Super Admin can assign privileged roles");
  }
  return r.rows as { id: string; key: string }[];
}

export async function employeeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/employees", async (req) => {
    const p = req.principal;
    const scope = requirePermission(p, "employees.read");
    const q = parse(
      Pagination.extend({
        branchId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(),
        status: z.enum(EMPLOYMENT_STATUSES).optional(),
        q: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const params: unknown[] = [p.orgId];
    const where = ["e.organisation_id = $1", employeeScopeSql(p, scope, params)];
    if (q.branchId) where.push(`e.branch_id = $${params.push(q.branchId)}`);
    if (q.departmentId) where.push(`e.department_id = $${params.push(q.departmentId)}`);
    if (q.status) where.push(`e.status = $${params.push(q.status)}`);
    if (q.q) where.push(`(e.full_name ILIKE $${params.push(`%${q.q}%`)} OR e.employee_code ILIKE $${params.length} OR e.email ILIKE $${params.length})`);
    if (q.cursor) where.push(`e.employee_code > $${params.push(q.cursor)}`);
    params.push(q.limit + 1);
    const r = await app.db.query(`SELECT ${PUBLIC_COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY e.employee_code LIMIT $${params.length}`, params);
    const items = r.rows.slice(0, q.limit);
    return { items, nextCursor: r.rows.length > q.limit ? items[items.length - 1]?.employee_code : null };
  });

  app.get("/employees/:id", async (req) => {
    const { id } = parse(IdParam, req.params);
    const emp = await loadScoped(app, req.principal, id);
    const roles = await app.db.query("SELECT r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1", [emp.user_id]);
    return { ...emp, roles: roles.rows };
  });

  app.get("/employees/:id/history", async (req) => {
    const { id } = parse(IdParam, req.params);
    await loadScoped(app, req.principal, id);
    requirePermission(req.principal, "employees.manage");
    const r = await app.db.query("SELECT * FROM employee_history WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 200", [id]);
    return { items: r.rows };
  });

  /** Restricted: bank and statutory identifiers. Every read is audited. */
  app.get("/employees/:id/sensitive", async (req) => {
    const { id } = parse(IdParam, req.params);
    const emp = await loadScoped(app, req.principal, id);
    const isSelf = emp.user_id === req.principal.userId;
    if (!isSelf) requirePermission(req.principal, "employees.sensitive.read", "org");
    const r = await app.db.query("SELECT data_enc, updated_at FROM employee_sensitive WHERE employee_id = $1", [id]);
    await audit(app.db, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "employee.sensitive_read", entityType: "employee", entityId: id, ...reqMeta(req) });
    if (!r.rows[0]) return { data: {} };
    return { data: JSON.parse(decrypt(r.rows[0].data_enc, app.config.DATA_ENCRYPTION_KEY)), updatedAt: r.rows[0].updated_at };
  });

  app.put("/employees/:id/sensitive", async (req) => {
    const { id } = parse(IdParam, req.params);
    requirePermission(req.principal, "employees.manage", "org");
    requirePermission(req.principal, "employees.sensitive.read", "org");
    const data = parse(
      z.object({
        bankAccountName: z.string().max(120).optional(),
        bankAccountNumber: z.string().regex(/^\d{6,20}$/).optional(),
        ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
        pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/).optional(),
        uan: z.string().regex(/^\d{12}$/).optional(),
      }),
      req.body,
    );
    await loadScoped(app, req.principal, id);
    await withTx(app.db, async (tx) => {
      await tx.query(
        `INSERT INTO employee_sensitive (employee_id, data_enc, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (employee_id) DO UPDATE SET data_enc = EXCLUDED.data_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, encrypt(JSON.stringify(data), app.config.DATA_ENCRYPTION_KEY), req.principal.userId],
      );
      // Field names only; values are never written to the audit log.
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "employee.sensitive_update", entityType: "employee", entityId: id, after: { fields: Object.keys(data) }, ...reqMeta(req) });
    });
    return { ok: true };
  });

  /** Admin creates the employee and their login together. */
  app.post("/employees", async (req, reply) => {
    const p = req.principal;
    requirePermission(p, "employees.manage", "org");
    requirePermission(p, "users.manage", "org");
    const b = parse(CreateEmployeeInput, req.body);
    const result = await withTx(app.db, async (tx) => {
      const roles = await resolveRoles(tx, p, b.roleKeys);
      const code = b.employeeCode ?? `RS${String((await tx.query("SELECT nextval('employee_code_seq') AS n")).rows[0].n).padStart(4, "0")}`;
      const user = (
        await tx.query(
          `INSERT INTO users (organisation_id, kind, email, display_name, password_hash, must_change_password, status, created_by)
           VALUES ($1,'staff',$2,$3,$4,$5,$6,$7) RETURNING id`,
          [p.orgId, b.email, b.fullName, b.initialPassword ? await hashPassword(b.initialPassword) : null, Boolean(b.initialPassword), b.initialPassword ? "active" : "invited", p.userId],
        )
      ).rows[0];
      for (const r of roles) await tx.query("INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1,$2,$3)", [user.id, r.id, p.userId]);
      const emp = (
        await tx.query(
          `INSERT INTO employees (organisation_id, user_id, employee_code, full_name, email, phone, branch_id, department_id, designation_id,
                                  reporting_manager_id, employment_type, joining_date, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'onboarding',$13) RETURNING *`,
          [p.orgId, user.id, code, b.fullName, b.email, b.phone ?? null, b.branchId, b.departmentId, b.designationId ?? null, b.reportingManagerId ?? null, b.employmentType, b.joiningDate, p.userId],
        )
      ).rows[0];
      await tx.query("INSERT INTO employee_history (employee_id, kind, after, actor_id) VALUES ($1,'created',$2,$3)", [emp.id, JSON.stringify({ ...emp, roles: b.roleKeys }), p.userId]);
      let inviteUrl: string | null = null;
      if (!b.initialPassword) {
        const token = await issueOneTimeToken(tx, user.id, "invite", 72);
        inviteUrl = `${app.config.APP_BASE_URL}/accept-invite?token=${token}`;
      }
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "employee.create", entityType: "employee", entityId: emp.id, after: { ...emp, roles: b.roleKeys }, ...reqMeta(req) });
      return { employee: emp, inviteUrl };
    });
    if (result.inviteUrl) {
      await app.mailer.send({ to: b.email, subject: "Your account is ready", text: `You have been invited. Set your password within 72 hours: ${result.inviteUrl}` });
    }
    // The invite link is also returned to the admin so it can be shared while email is in test mode.
    return reply.status(201).send({ ...result.employee, inviteUrl: result.inviteUrl, mailMode: app.mailer.mode });
  });

  app.patch("/employees/:id", async (req) => {
    const p = req.principal;
    const { id } = parse(IdParam, req.params);
    const b = parse(UpdateEmployeeInput, req.body);
    const scope = requirePermission(p, "employees.manage");
    await loadScoped(app, p, id);
    if (scope !== "org" && (b.branchId || b.departmentId)) throw forbidden("Only organisation-wide HR can transfer employees");
    return withTx(app.db, async (tx) => {
      const before = (await tx.query("SELECT * FROM employees WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (b.reportingManagerId === id) throw badRequest("An employee cannot report to themselves");
      const map: Record<string, unknown> = {
        employee_code: b.employeeCode, full_name: b.fullName, phone: b.phone, branch_id: b.branchId, department_id: b.departmentId,
        designation_id: b.designationId, reporting_manager_id: b.reportingManagerId, employment_type: b.employmentType,
        joining_date: b.joiningDate, status: b.status,
      };
      const cols = Object.keys(map).filter((k) => map[k] !== undefined);
      if (!cols.length) throw badRequest("Nothing to update");
      const after = (
        await tx.query(`UPDATE employees SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_by = $${cols.length + 2} WHERE id = $1 RETURNING *`, [
          id,
          ...cols.map((c) => map[c]),
          p.userId,
        ])
      ).rows[0];
      if (b.status === "exited") {
        await tx.query("UPDATE employees SET exit_date = COALESCE(exit_date, current_date) WHERE id = $1", [id]);
        await tx.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [before.user_id]);
        await tx.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [before.user_id]);
      }
      const kinds: [string, string[]][] = [
        ["transfer", ["branch_id", "department_id"]],
        ["status", ["status"]],
        ["designation", ["designation_id"]],
        ["manager", ["reporting_manager_id"]],
      ];
      for (const [kind, fields] of kinds) {
        if (fields.some((f) => map[f] !== undefined && String(before[f]) !== String(after[f]))) {
          await tx.query("INSERT INTO employee_history (employee_id, kind, before, after, actor_id) VALUES ($1,$2,$3,$4,$5)", [
            id, kind, JSON.stringify(Object.fromEntries(fields.map((f) => [f, before[f]]))), JSON.stringify(Object.fromEntries(fields.map((f) => [f, after[f]]))), p.userId,
          ]);
        }
      }
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "employee.update", entityType: "employee", entityId: id, before, after, ...reqMeta(req) });
      return after;
    });
  });

  app.put("/employees/:id/roles", async (req) => {
    const p = req.principal;
    requirePermission(p, "users.manage", "org");
    const { id } = parse(IdParam, req.params);
    const { roleKeys } = parse(AssignRolesInput, req.body);
    return withTx(app.db, async (tx) => {
      const emp = (await tx.query("SELECT user_id FROM employees WHERE id = $1 AND organisation_id = $2", [id, p.orgId])).rows[0];
      if (!emp) throw notFound("Employee");
      if (emp.user_id === p.userId) throw forbidden("You cannot change your own roles");
      const roles = await resolveRoles(tx, p, roleKeys);
      const before = (await tx.query("SELECT r.key, r.mfa_required FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1", [emp.user_id])).rows;
      if (before.some((r) => r.mfa_required) && !scopeOf(p, "roles.manage")) throw forbidden("Only a Super Admin can change a privileged user's roles");
      await tx.query("DELETE FROM user_roles WHERE user_id = $1", [emp.user_id]);
      for (const r of roles) await tx.query("INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1,$2,$3)", [emp.user_id, r.id, p.userId]);
      await tx.query("INSERT INTO employee_history (employee_id, kind, before, after, actor_id) VALUES ($1,'roles',$2,$3,$4)", [id, JSON.stringify(before.map((r) => r.key)), JSON.stringify(roleKeys), p.userId]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "employee.roles_update", entityType: "employee", entityId: id, before: before.map((r) => r.key), after: roleKeys, ...reqMeta(req) });
      return { roleKeys };
    });
  });

  app.post("/employees/:id/deactivate", async (req) => {
    const p = req.principal;
    requirePermission(p, "users.manage", "org");
    const { id } = parse(IdParam, req.params);
    await withTx(app.db, async (tx) => {
      const emp = (await tx.query("SELECT user_id FROM employees WHERE id = $1 AND organisation_id = $2", [id, p.orgId])).rows[0];
      if (!emp) throw notFound("Employee");
      if (emp.user_id === p.userId) throw forbidden("You cannot deactivate your own account");
      await tx.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [emp.user_id]);
      await tx.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [emp.user_id]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "user.deactivate", entityType: "employee", entityId: id, ...reqMeta(req) });
    });
    return { ok: true };
  });

  app.post("/employees/:id/reset-access", async (req) => {
    const p = req.principal;
    requirePermission(p, "users.manage", "org");
    const { id } = parse(IdParam, req.params);
    const out = await withTx(app.db, async (tx) => {
      const emp = (await tx.query("SELECT e.user_id, e.email FROM employees e WHERE e.id = $1 AND e.organisation_id = $2", [id, p.orgId])).rows[0];
      if (!emp) throw notFound("Employee");
      if (emp.user_id === p.userId) throw badRequest("Use Settings to change your own password");
      const privileged = (
        await tx.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.mfa_required", [emp.user_id])
      ).rowCount;
      if (privileged && !scopeOf(p, "roles.manage")) throw forbidden("Only a Super Admin can reset a privileged user's access");
      // A lost phone is the usual reason for a reset, so two-factor sign-in is cleared too;
      // the person sets it up again after choosing a new password.
      await tx.query("UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL WHERE id = $1", [emp.user_id]);
      const token = await issueOneTimeToken(tx, emp.user_id, "password_reset", 24);
      await tx.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [emp.user_id]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "user.reset_access", entityType: "employee", entityId: id, ...reqMeta(req) });
      return { email: emp.email, url: `${app.config.APP_BASE_URL}/reset-password?token=${token}` };
    });
    await app.mailer.send({ to: out.email, subject: "Reset your password", text: `An administrator reset your access. Set a new password within 24 hours: ${out.url}` });
    return { ok: true, resetUrl: out.url, mailMode: app.mailer.mode };
  });
}

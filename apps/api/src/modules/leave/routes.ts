import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LeaveAdjustInput, LeaveApplyInput, LeaveTypeInput, ReviewInput, accruedFor, countLeaveDays, dateInZone } from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requireOnRecord, requirePermission, scopeCovers, scopeOf, type Principal } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { withTx, type Queryable } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { employeeScopeSql } from "../employees/routes.js";
import { loadEmployee, nonWorkingChecker, notify, rebuildLedger, scopedRecord, selfEmployeeId, type EmployeeRec } from "../attendance/common.js";

const IdParam = z.object({ id: z.string().uuid() });
const n = (v: unknown) => Number(v ?? 0);

function typeDto(r: Record<string, unknown>) {
  return {
    id: r.id, code: r.code, name: r.name, paid: r.paid, annualQuota: n(r.annual_quota), accrual: r.accrual,
    carryForwardMax: n(r.carry_forward_max), allowHalfDay: r.allow_half_day,
    requiresDocumentAfterDays: r.requires_document_after_days === null ? null : n(r.requires_document_after_days),
    unlimited: r.unlimited, active: r.active,
  };
}

function balanceDto(r: Record<string, unknown>) {
  const opening = n(r.opening), accrued = n(r.accrued), adjusted = n(r.adjusted), used = n(r.used), pending = n(r.pending);
  return {
    leaveTypeId: r.leave_type_id, code: r.code, name: r.name, unlimited: r.unlimited, paid: r.paid, year: r.year,
    opening, accrued, adjusted, used, pending, available: r.unlimited ? null : opening + accrued + adjusted - used - pending,
  };
}

function requestDto(r: Record<string, unknown>) {
  return {
    id: r.id, employeeId: r.employee_id, employeeName: r.full_name, employeeCode: r.employee_code,
    leaveTypeId: r.leave_type_id, leaveTypeCode: r.code, leaveTypeName: r.type_name,
    startDate: r.start_date, endDate: r.end_date, startHalf: r.start_half, endHalf: r.end_half, days: n(r.days),
    reason: r.reason, documentRef: r.document_ref, status: r.status, approverName: r.approver_name ?? null,
    decisionNote: r.decision_note, decidedAt: r.decided_at, createdAt: r.created_at, version: r.version,
  };
}

const REQ_SELECT = `SELECT lr.*, to_char(lr.start_date,'YYYY-MM-DD') AS start_date, to_char(lr.end_date,'YYYY-MM-DD') AS end_date,
    e.full_name, e.employee_code, lt.code, lt.name AS type_name, au.display_name AS approver_name
  FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
  LEFT JOIN users au ON au.id = lr.approver_user_id LEFT JOIN employees m ON m.id = e.reporting_manager_id`;

/** Make sure balance rows exist for the year and that accrual is current. Returns the rows. */
async function ensureBalances(q: Queryable, orgId: string, emp: EmployeeRec, year: number, lock = false) {
  const today = dateInZone(new Date(), emp.timezone);
  const types = (await q.query(`SELECT * FROM leave_types WHERE organisation_id = $1 AND active`, [orgId])).rows;
  for (const t of types) {
    const accrued = accruedFor({ annualQuota: n(t.annual_quota), accrual: t.accrual }, year, emp.joining_date, today);
    await q.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, accrued) VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET accrued = EXCLUDED.accrued, updated_at = now()
       WHERE leave_balances.accrued IS DISTINCT FROM EXCLUDED.accrued`,
      [emp.id, t.id, year, accrued],
    );
  }
  return (
    await q.query(
      `SELECT lb.*, lt.code, lt.name, lt.unlimited, lt.paid FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
        WHERE lb.employee_id = $1 AND lb.year = $2 AND lt.active ORDER BY lt.code ${lock ? "FOR UPDATE OF lb" : ""}`,
      [emp.id, year],
    )
  ).rows;
}

function requireApprover(p: Principal, emp: EmployeeRec) {
  if (emp.user_id === p.userId) throw forbidden("You cannot approve your own leave");
  requireOnRecord(p, "leave.approve", scopedRecord(emp));
}

export async function leaveRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ── Leave types ───────────────────────────────────────────────────────────
  app.get("/leave/types", async (req) => {
    const p = req.principal;
    if (p.kind !== "staff") throw forbidden();
    const r = await app.db.query(`SELECT * FROM leave_types WHERE organisation_id = $1 ORDER BY active DESC, code`, [p.orgId]);
    return { items: r.rows.map(typeDto) };
  });

  app.post("/leave/types", async (req, reply) => {
    const p = req.principal;
    requirePermission(p, "leave.configure", "org");
    const i = parse(LeaveTypeInput, req.body);
    const row = await withTx(app.db, async (tx) => {
      const r = (
        await tx.query(
          `INSERT INTO leave_types (organisation_id, code, name, paid, annual_quota, accrual, carry_forward_max, allow_half_day, requires_document_after_days, unlimited, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [p.orgId, i.code, i.name, i.paid, i.annualQuota, i.accrual, i.carryForwardMax, i.allowHalfDay, i.requiresDocumentAfterDays ?? null, i.unlimited, i.active],
        )
      ).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "leave.type.create", entityType: "leave_type", entityId: r.id, after: i, ...reqMeta(req) });
      return r;
    });
    return reply.status(201).send(typeDto(row));
  });

  app.patch("/leave/types/:id", async (req) => {
    const p = req.principal;
    requirePermission(p, "leave.configure", "org");
    const { id } = parse(IdParam, req.params);
    const i = parse(LeaveTypeInput.partial().omit({ code: true }), req.body);
    return withTx(app.db, async (tx) => {
      const before = (await tx.query(`SELECT * FROM leave_types WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [id, p.orgId])).rows[0];
      if (!before) throw notFound("Leave type");
      const map: Record<string, string> = {
        name: "name", paid: "paid", annualQuota: "annual_quota", accrual: "accrual", carryForwardMax: "carry_forward_max",
        allowHalfDay: "allow_half_day", requiresDocumentAfterDays: "requires_document_after_days", unlimited: "unlimited", active: "active",
      };
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const [k, col] of Object.entries(map)) {
        if (k in i) sets.push(`${col} = $${vals.push((i as Record<string, unknown>)[k] ?? null)}`);
      }
      if (!sets.length) return typeDto(before);
      const r = (await tx.query(`UPDATE leave_types SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, vals)).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "leave.type.update", entityType: "leave_type", entityId: id, before: typeDto(before), after: i, ...reqMeta(req) });
      return typeDto(r);
    });
  });

  // ── Balances ──────────────────────────────────────────────────────────────
  app.get("/leave/balances", async (req) => {
    const p = req.principal;
    const q = parse(z.object({ employeeId: z.string().uuid().optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query);
    const empId = q.employeeId ?? selfEmployeeId(p);
    const emp = await loadEmployee(app.db, p.orgId, empId);
    const s = scopeOf(p, "leave.read");
    if (!s || !scopeCovers(p, s, scopedRecord(emp))) throw notFound("Employee");
    const year = q.year ?? Number(dateInZone(new Date(), emp.timezone).slice(0, 4));
    const rows = await withTx(app.db, (tx) => ensureBalances(tx, p.orgId, emp, year));
    return { employeeId: emp.id, year, items: rows.map(balanceDto) };
  });

  app.post("/leave/adjustments", async (req) => {
    const p = req.principal;
    requirePermission(p, "leave.configure", "org");
    const i = parse(LeaveAdjustInput, req.body);
    return withTx(app.db, async (tx) => {
      const emp = await loadEmployee(tx, p.orgId, i.employeeId);
      if (emp.user_id === p.userId) throw forbidden("You cannot adjust your own leave balance");
      const t = await tx.query(`SELECT 1 FROM leave_types WHERE id = $1 AND organisation_id = $2`, [i.leaveTypeId, p.orgId]);
      if (!t.rowCount) throw notFound("Leave type");
      await ensureBalances(tx, p.orgId, emp, i.year, true);
      const r = (
        await tx.query(`UPDATE leave_balances SET adjusted = adjusted + $4, updated_at = now() WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3 RETURNING *`, [emp.id, i.leaveTypeId, i.year, i.delta])
      ).rows[0];
      if (!r) throw badRequest("That leave type is not active");
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "leave.balance.adjust", entityType: "employee", entityId: emp.id, after: i, ...reqMeta(req) });
      await notify(tx, p.orgId, emp.user_id, "leave.adjusted", `Leave balance adjusted by ${i.delta > 0 ? "+" : ""}${i.delta} day(s)`, i.reason, "employee", emp.id);
      return { ok: true };
    });
  });

  /** Year-end: carry unused balance into next year's opening, capped per leave type. Idempotent (sets, not adds). */
  app.post("/leave/carry-forward", async (req) => {
    const p = req.principal;
    requirePermission(p, "leave.configure", "org");
    const { year } = parse(z.object({ year: z.number().int().min(2000).max(2100) }), req.body);
    return withTx(app.db, async (tx) => {
      const r = await tx.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, opening)
         SELECT lb.employee_id, lb.leave_type_id, $2::int + 1,
                LEAST(lt.carry_forward_max, GREATEST(0, lb.opening + lb.accrued + lb.adjusted - lb.used - lb.pending))
           FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id JOIN employees e ON e.id = lb.employee_id
          WHERE lt.organisation_id = $1 AND lb.year = $2 AND lt.carry_forward_max > 0 AND NOT lt.unlimited AND e.status NOT IN ('exited','archived')
         ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET opening = EXCLUDED.opening, updated_at = now()`,
        [p.orgId, year],
      );
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "leave.carry_forward", entityType: "organisation", entityId: p.orgId, after: { year, rows: r.rowCount }, ...reqMeta(req) });
      return { year, toYear: year + 1, balancesUpdated: r.rowCount };
    });
  });

  // ── Requests ──────────────────────────────────────────────────────────────
  app.post("/leave/requests", async (req, reply) => {
    const p = req.principal;
    requirePermission(p, "leave.self");
    const i = parse(LeaveApplyInput, req.body);
    const out = await withTx(app.db, async (tx) => {
      const emp = await loadEmployee(tx, p.orgId, selfEmployeeId(p));
      const type = (await tx.query(`SELECT * FROM leave_types WHERE id = $1 AND organisation_id = $2 AND active`, [i.leaveTypeId, p.orgId])).rows[0];
      if (!type) throw notFound("Leave type");
      if ((i.startHalf || i.endHalf) && !type.allow_half_day) throw badRequest(`${type.name} cannot be taken as a half day`);
      if (i.startDate < emp.joining_date) throw badRequest("Leave cannot start before your joining date");

      const isOff = await nonWorkingChecker(tx, p.orgId, emp.branch_id, i.startDate, i.endDate);
      const days = countLeaveDays(i, isOff);
      if (days <= 0) throw badRequest("Those dates are all holidays or weekly offs");
      if (type.requires_document_after_days !== null && days > n(type.requires_document_after_days) && !i.documentRef) {
        throw badRequest(`Attach a supporting document for ${type.name} longer than ${n(type.requires_document_after_days)} day(s)`, { code: "document_required" });
      }

      const overlap = await tx.query(
        `SELECT 1 FROM leave_requests WHERE employee_id = $1 AND status IN ('pending','approved') AND start_date <= $3 AND end_date >= $2`,
        [emp.id, i.startDate, i.endDate],
      );
      if (overlap.rowCount) throw conflict("You already have leave on some of these dates");

      const year = Number(i.startDate.slice(0, 4));
      const balances = await ensureBalances(tx, p.orgId, emp, year, true);
      const bal = balances.find((b) => b.leave_type_id === type.id);
      if (!bal) throw badRequest("No balance for this leave type");
      if (!type.unlimited) {
        const available = balanceDto(bal).available ?? 0;
        if (days > available) throw badRequest(`Not enough ${type.name} balance: ${available} day(s) available, ${days} requested`, { code: "insufficient_balance", available, requested: days });
      }

      const row = (
        await tx.query(
          `INSERT INTO leave_requests (organisation_id, employee_id, leave_type_id, start_date, end_date, start_half, end_half, days, reason, document_ref, approver_user_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [p.orgId, emp.id, type.id, i.startDate, i.endDate, i.startHalf, i.endHalf, days, i.reason, i.documentRef ?? null, emp.manager_user_id, p.userId],
        )
      ).rows[0];
      await tx.query(`UPDATE leave_balances SET pending = pending + $4, updated_at = now() WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`, [emp.id, type.id, year, days]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "leave.apply", entityType: "leave_request", entityId: row.id, after: { ...i, days }, ...reqMeta(req) });
      await notify(tx, p.orgId, emp.manager_user_id, "leave.requested", `${emp.full_name} applied for ${days} day(s) ${type.name}`,
        `${i.startDate}${i.endDate !== i.startDate ? ` to ${i.endDate}` : ""}: ${i.reason}`, "leave_request", row.id);
      return (await tx.query(`${REQ_SELECT} WHERE lr.id = $1`, [row.id])).rows[0];
    });
    return reply.status(201).send(requestDto(out));
  });

  app.get("/leave/requests", async (req) => {
    const p = req.principal;
    const q = parse(
      z.object({
        view: z.enum(["mine", "review", "all"]).default("mine"),
        status: z.enum(["pending", "approved", "rejected", "cancelled", "withdrawn"]).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.query,
    );
    const params: unknown[] = [p.orgId];
    const where = [`lr.organisation_id = $1`];
    if (q.view === "mine") {
      where.push(`e.user_id = $${params.push(p.userId)}`);
    } else if (q.view === "review") {
      const s = requirePermission(p, "leave.approve");
      where.push(`e.user_id <> $${params.push(p.userId)}`, employeeScopeSql(p, s, params));
    } else {
      const s = requirePermission(p, "leave.read");
      where.push(employeeScopeSql(p, s, params));
    }
    if (q.status) where.push(`lr.status = $${params.push(q.status)}`);
    if (q.from) where.push(`lr.end_date >= $${params.push(q.from)}`);
    if (q.to) where.push(`lr.start_date <= $${params.push(q.to)}`);
    const r = await app.db.query(`${REQ_SELECT} WHERE ${where.join(" AND ")} ORDER BY lr.start_date DESC, lr.created_at DESC LIMIT 200`, params);
    return { items: r.rows.map(requestDto) };
  });

  app.post("/leave/requests/:id/decide", async (req) => {
    const p = req.principal;
    const { id } = parse(IdParam, req.params);
    const i = parse(ReviewInput.and(z.object({ expectedVersion: z.number().int().positive().optional() })), req.body);
    return withTx(app.db, async (tx) => {
      const lr = (await tx.query(`SELECT *, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date FROM leave_requests WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [id, p.orgId])).rows[0];
      if (!lr) throw notFound("Leave request");
      const emp = await loadEmployee(tx, p.orgId, lr.employee_id);
      const s = scopeOf(p, "leave.approve");
      const canSee = scopeOf(p, "leave.read");
      if ((!s || !scopeCovers(p, s, scopedRecord(emp))) && (!canSee || !scopeCovers(p, canSee, scopedRecord(emp)))) throw notFound("Leave request");
      requireApprover(p, emp);
      if (i.expectedVersion && i.expectedVersion !== lr.version) throw conflict("This request changed since you opened it", { currentVersion: lr.version });
      if (lr.status !== "pending") throw conflict(`This request is already ${lr.status}`);

      const status = i.decision === "approve" ? "approved" : "rejected";
      const year = Number(lr.start_date.slice(0, 4));
      await ensureBalances(tx, p.orgId, emp, year, true);
      await tx.query(
        `UPDATE leave_balances SET pending = GREATEST(0, pending - $4), used = used + $5, updated_at = now() WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
        [emp.id, lr.leave_type_id, year, lr.days, status === "approved" ? lr.days : 0],
      );
      await tx.query(
        `UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, status, p.userId, i.note ?? null],
      );
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: `leave.${i.decision}`, entityType: "leave_request", entityId: id, before: { status: lr.status }, after: { status, note: i.note }, ...reqMeta(req) });
      await notify(tx, p.orgId, emp.user_id, "leave.decided", `Your leave (${lr.start_date}) was ${status}`, i.note ?? "", "leave_request", id);
      if (status === "approved") await rebuildLedger(tx, p.orgId, [emp.id], lr.start_date, lr.end_date);
      return requestDto((await tx.query(`${REQ_SELECT} WHERE lr.id = $1`, [id])).rows[0]);
    });
  });

  app.post("/leave/requests/:id/cancel", async (req) => {
    const p = req.principal;
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    return withTx(app.db, async (tx) => {
      const lr = (await tx.query(`SELECT *, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date FROM leave_requests WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [id, p.orgId])).rows[0];
      if (!lr) throw notFound("Leave request");
      const emp = await loadEmployee(tx, p.orgId, lr.employee_id);
      const own = emp.user_id === p.userId;
      const today = dateInZone(new Date(), emp.timezone);
      if (!own) {
        const s = scopeOf(p, "leave.read");
        if (!s || !scopeCovers(p, s, scopedRecord(emp))) throw notFound("Leave request");
      }
      let status: "withdrawn" | "cancelled";
      if (lr.status === "pending") {
        if (!own) throw forbidden("Reject the request instead");
        status = "withdrawn";
      } else if (lr.status === "approved") {
        // Before leave starts the employee may cancel; once it has started only an approver can.
        if (own && lr.start_date <= today) throw forbidden("This leave has started. Ask your manager or HR to cancel it.");
        if (!own) requireApprover(p, emp);
        if (!reason || reason.length < 3) throw badRequest("Give a reason for cancelling approved leave");
        status = "cancelled";
      } else {
        throw conflict(`This request is already ${lr.status}`);
      }
      const year = Number(lr.start_date.slice(0, 4));
      await ensureBalances(tx, p.orgId, emp, year, true);
      await tx.query(
        status === "withdrawn"
          ? `UPDATE leave_balances SET pending = GREATEST(0, pending - $4), updated_at = now() WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`
          : `UPDATE leave_balances SET used = GREATEST(0, used - $4), updated_at = now() WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
        [emp.id, lr.leave_type_id, year, lr.days],
      );
      await tx.query(`UPDATE leave_requests SET status = $2, decision_note = COALESCE($3, decision_note), version = version + 1, updated_at = now() WHERE id = $1`, [id, status, reason ?? null]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: `leave.${status === "withdrawn" ? "withdraw" : "cancel"}`, entityType: "leave_request", entityId: id, before: { status: lr.status }, after: { status, reason }, ...reqMeta(req) });
      if (!own) await notify(tx, p.orgId, emp.user_id, "leave.cancelled", `Your leave (${lr.start_date}) was cancelled`, reason ?? "", "leave_request", id);
      else if (lr.status === "approved") await notify(tx, p.orgId, lr.decided_by, "leave.cancelled", `${emp.full_name} cancelled approved leave (${lr.start_date})`, reason ?? "", "leave_request", id);
      if (lr.status === "approved") await rebuildLedger(tx, p.orgId, [emp.id], lr.start_date, lr.end_date);
      return requestDto((await tx.query(`${REQ_SELECT} WHERE lr.id = $1`, [id])).rows[0]);
    });
  });
}

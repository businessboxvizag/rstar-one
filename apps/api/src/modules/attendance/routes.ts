import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ATTENDANCE_FLAGS,
  CheckEventInput,
  CorrectionInput,
  GeofenceInput,
  HolidayInput,
  PolicyInput,
  ReviewInput,
  addDays,
  dateInZone,
  evaluateCheck,
} from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requireOnRecord, requirePermission, scopeCovers, scopeOf, type Principal } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { withTx, type Queryable } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { employeeScopeSql } from "../employees/routes.js";
import { clampRange, loadEmployee, notify, policyFor, rebuildLedger, scopedRecord, selfEmployeeId, type EmployeeRec } from "./common.js";

/** Version of the location notice shown to employees before their first GPS check-in. */
export const LOCATION_CONSENT_VERSION = "2026-11";
const CORRECTION_WINDOW_DAYS = 45;

const IdParam = z.object({ id: z.string().uuid() });
const BigIdParam = z.object({ id: z.coerce.number().int().positive() });
const DateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RangeQuery = z.object({
  from: DateQ.optional(),
  to: DateQ.optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
});

async function geofenceFor(q: Queryable, branchId: string) {
  const g = (await q.query(`SELECT * FROM geofences WHERE branch_id = $1 AND active`, [branchId])).rows[0];
  return g
    ? { id: g.id as string, latitude: Number(g.latitude), longitude: Number(g.longitude), radiusM: g.radius_m as number, maxAccuracyM: g.max_accuracy_m as number }
    : null;
}

function eventDto(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    employeeId: r.employee_id,
    employeeName: r.full_name ?? undefined,
    employeeCode: r.employee_code ?? undefined,
    workDate: r.work_date,
    kind: r.kind,
    mode: r.mode,
    serverTime: r.server_time,
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
    accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
    distanceM: r.distance_m === null ? null : Number(r.distance_m),
    result: r.result,
    flags: (r.flags as string[]).map((f) => ({ code: f, label: ATTENDANCE_FLAGS[f as keyof typeof ATTENDANCE_FLAGS] ?? f })),
    note: r.note,
    reviewNote: r.review_note,
    reviewedAt: r.reviewed_at,
  };
}

const EVENT_COLS = `ev.id, ev.employee_id, to_char(ev.work_date,'YYYY-MM-DD') AS work_date, ev.kind, ev.mode, ev.server_time, ev.latitude, ev.longitude,
  ev.accuracy_m, ev.distance_m, ev.result, ev.flags, ev.note, ev.review_note, ev.reviewed_at`;

const DAY_COLS = `ad.employee_id, to_char(ad.work_date,'YYYY-MM-DD') AS work_date, ad.status, ad.first_in, ad.last_out, ad.worked_minutes,
  ad.late_minutes, ad.early_minutes, ad.source, ad.needs_review`;

/** Reviewers may act only on records their scope covers, and never on their own. */
function requireReviewer(p: Principal, emp: EmployeeRec) {
  if (emp.user_id === p.userId) throw forbidden("You cannot approve your own attendance");
  requireOnRecord(p, "attendance.approve", scopedRecord(emp));
}

export async function attendanceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ── Self-service ──────────────────────────────────────────────────────────
  app.post("/attendance/consent", async (req) => {
    const p = req.principal;
    requirePermission(p, "attendance.self");
    const empId = selfEmployeeId(p);
    await withTx(app.db, async (tx) => {
      await tx.query(`UPDATE employees SET location_consent_at = now(), location_consent_version = $2 WHERE id = $1`, [empId, LOCATION_CONSENT_VERSION]);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "attendance.location_consent", entityType: "employee", entityId: empId, after: { version: LOCATION_CONSENT_VERSION }, ...reqMeta(req) });
    });
    return { consentVersion: LOCATION_CONSENT_VERSION };
  });

  app.get("/attendance/me/today", async (req) => {
    const p = req.principal;
    requirePermission(p, "attendance.self");
    const emp = await loadEmployee(app.db, p.orgId, selfEmployeeId(p));
    const today = dateInZone(new Date(), emp.timezone);
    await rebuildLedger(app.db, p.orgId, [emp.id], today, today);
    const [events, day, geofence, policy, lastEv] = await Promise.all([
      app.db.query(`SELECT ${EVENT_COLS} FROM attendance_events ev WHERE ev.employee_id = $1 AND ev.work_date = $2 ORDER BY ev.server_time`, [emp.id, today]),
      app.db.query(`SELECT ${DAY_COLS} FROM attendance_days ad WHERE ad.employee_id = $1 AND ad.work_date = $2`, [emp.id, today]),
      geofenceFor(app.db, emp.branch_id),
      policyFor(app.db, p.orgId, emp.branch_id),
      app.db.query(`SELECT kind, server_time, to_char(work_date,'YYYY-MM-DD') AS work_date FROM attendance_events WHERE employee_id = $1 AND result <> 'rejected' ORDER BY server_time DESC LIMIT 1`, [emp.id]),
    ]);
    const last = lastEv.rows[0];
    // Open session from today, or from yesterday (night shoot past midnight) — can still be checked out.
    const open = last?.kind === "check_in" && last.work_date >= addDays(today, -1);
    return {
      date: today,
      timeZone: emp.timezone,
      checkedIn: open,
      openSince: open ? last.server_time : null,
      events: events.rows.map(eventDto),
      day: day.rows[0] ?? null,
      office: geofence ? { configured: true, latitude: geofence.latitude, longitude: geofence.longitude, radiusM: geofence.radiusM, maxAccuracyM: geofence.maxAccuracyM } : { configured: false },
      policy,
      consent: { given: Boolean(emp.location_consent_at), version: LOCATION_CONSENT_VERSION },
    };
  });

  app.post("/attendance/events", async (req, reply) => {
    const p = req.principal;
    requirePermission(p, "attendance.self");
    const input = parse(CheckEventInput, req.body);
    const empId = selfEmployeeId(p);

    const out = await withTx(app.db, async (tx) => {
      // Serialise check-ins per employee so double taps cannot create two open sessions.
      await tx.query(`SELECT id FROM employees WHERE id = $1 FOR UPDATE`, [empId]);
      if (input.idempotencyKey) {
        const dup = (await tx.query(`SELECT ${EVENT_COLS} FROM attendance_events ev WHERE ev.employee_id = $1 AND ev.idempotency_key = $2`, [empId, input.idempotencyKey])).rows[0];
        if (dup) return { event: eventDto(dup), replay: true };
      }
      const emp = await loadEmployee(tx, p.orgId, empId);
      const hasLoc = input.latitude != null && input.longitude != null;
      if (hasLoc && !emp.location_consent_at) throw badRequest("Please read and accept the location notice before checking in", { code: "consent_required" });

      const now = new Date();
      const today = dateInZone(now, emp.timezone);
      const prev = (
        await tx.query(`SELECT kind, latitude, longitude, server_time, work_date FROM attendance_events WHERE employee_id = $1 AND result <> 'rejected' ORDER BY server_time DESC LIMIT 1`, [empId])
      ).rows[0];
      const openSession = prev?.kind === "check_in";
      const openDate = openSession ? dateInZone(new Date(prev.server_time), emp.timezone) : null;
      // An open session from an earlier day does not block today's check-in: that day is left
      // for review/correction (missing check-out) and today starts fresh.
      if (input.kind === "check_in" && openDate === today) throw conflict("You are already checked in. Check out first.");
      if (input.kind === "check_out" && !openSession) throw conflict("You are not checked in.");
      // A check-out belongs to the day of its check-in (night shoots run past midnight).
      const workDate = input.kind === "check_out" ? openDate! : today;
      if (input.kind === "check_out" && workDate < addDays(today, -1)) {
        throw conflict("Your last check-in was more than a day ago. Ask for an attendance correction instead.", { code: "stale_session" });
      }

      const [geofence, policy] = await Promise.all([geofenceFor(tx, emp.branch_id), policyFor(tx, p.orgId, emp.branch_id)]);
      const verdict = evaluateCheck(
        { mode: input.mode, latitude: input.latitude, longitude: input.longitude, accuracyM: input.accuracyM, mocked: input.mocked, clientTime: input.clientTime ? new Date(input.clientTime) : null },
        {
          geofence,
          policy,
          now,
          previous: prev && prev.latitude !== null ? { latitude: Number(prev.latitude), longitude: Number(prev.longitude), at: new Date(prev.server_time) } : null,
        },
      );
      const row = (
        await tx.query(
          `INSERT INTO attendance_events (organisation_id, employee_id, work_date, kind, mode, server_time, client_time, latitude, longitude, accuracy_m, distance_m,
             geofence_id, result, flags, note, device_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING id, employee_id, to_char(work_date,'YYYY-MM-DD') AS work_date, kind, mode, server_time, latitude, longitude, accuracy_m, distance_m, result, flags, note, review_note, reviewed_at`,
          [
            p.orgId, empId, workDate, input.kind, input.mode, now, input.clientTime ?? null,
            input.latitude ?? null, input.longitude ?? null, input.accuracyM ?? null, verdict.distanceM,
            geofence?.id ?? null, verdict.result, verdict.flags, input.note ?? null, input.deviceId ?? null, input.idempotencyKey ?? null,
          ],
        )
      ).rows[0];
      if (verdict.result === "pending_exception") {
        await notify(tx, p.orgId, emp.manager_user_id, "attendance.exception", `${emp.full_name}: attendance needs review`,
          verdict.flags.map((f) => ATTENDANCE_FLAGS[f]).join("; "), "attendance_event", String(row.id));
      }
      await rebuildLedger(tx, p.orgId, [empId], workDate, workDate, now);
      return { event: eventDto(row), replay: false };
    });
    return reply.status(out.replay ? 200 : 201).send(out.event);
  });

  app.get("/attendance/me", async (req) => {
    const p = req.principal;
    requirePermission(p, "attendance.self");
    const emp = await loadEmployee(app.db, p.orgId, selfEmployeeId(p));
    const q = parse(RangeQuery, req.query);
    const { from, to } = clampRange(q.from, q.to, dateInZone(new Date(), emp.timezone));
    await rebuildLedger(app.db, p.orgId, [emp.id], from, to);
    const days = await app.db.query(`SELECT ${DAY_COLS} FROM attendance_days ad WHERE ad.employee_id = $1 AND ad.work_date BETWEEN $2 AND $3 ORDER BY ad.work_date`, [emp.id, from, to]);
    return { from, to, days: days.rows, summary: summarise(days.rows) };
  });

  // ── Register (managers, HR) ───────────────────────────────────────────────
  app.get("/attendance/register", async (req) => {
    const p = req.principal;
    const scope = requirePermission(p, "attendance.read");
    const q = parse(RangeQuery, req.query);
    const { from, to } = clampRange(q.from, q.to, dateInZone(new Date(), "Asia/Kolkata"));
    const params: unknown[] = [p.orgId];
    const where = [`e.organisation_id = $1`, `e.status NOT IN ('exited','archived')`, employeeScopeSql(p, scope, params)];
    if (q.branchId) where.push(`e.branch_id = $${params.push(q.branchId)}`);
    if (q.departmentId) where.push(`e.department_id = $${params.push(q.departmentId)}`);
    if (q.employeeId) where.push(`e.id = $${params.push(q.employeeId)}`);
    const emps = (
      await app.db.query(
        `SELECT e.id, e.employee_code, e.full_name, b.name AS branch_name, d.name AS department_name
           FROM employees e JOIN branches b ON b.id = e.branch_id JOIN departments d ON d.id = e.department_id
           LEFT JOIN employees m ON m.id = e.reporting_manager_id
          WHERE ${where.join(" AND ")} ORDER BY e.full_name LIMIT 500`,
        params,
      )
    ).rows;
    const ids = emps.map((e) => e.id);
    await rebuildLedger(app.db, p.orgId, ids, from, to);
    const days = ids.length
      ? (await app.db.query(`SELECT ${DAY_COLS} FROM attendance_days ad WHERE ad.employee_id = ANY($1) AND ad.work_date BETWEEN $2 AND $3 ORDER BY ad.work_date`, [ids, from, to])).rows
      : [];
    return {
      from,
      to,
      employees: emps.map((e) => {
        const mine = days.filter((d) => d.employee_id === e.id);
        return { ...e, days: mine, summary: summarise(mine) };
      }),
    };
  });

  // ── Exceptions ────────────────────────────────────────────────────────────
  app.get("/attendance/exceptions", async (req) => {
    const p = req.principal;
    const scope = requirePermission(p, "attendance.approve");
    const params: unknown[] = [p.orgId, p.userId];
    const where = employeeScopeSql(p, scope, params);
    const r = await app.db.query(
      `SELECT ${EVENT_COLS}, e.full_name, e.employee_code FROM attendance_events ev
         JOIN employees e ON e.id = ev.employee_id LEFT JOIN employees m ON m.id = e.reporting_manager_id
        WHERE ev.organisation_id = $1 AND ev.result = 'pending_exception' AND e.user_id <> $2 AND ${where}
        ORDER BY ev.server_time LIMIT 200`,
      params,
    );
    return { items: r.rows.map(eventDto) };
  });

  app.post("/attendance/events/:id/review", async (req) => {
    const p = req.principal;
    const { id } = parse(BigIdParam, req.params);
    const input = parse(ReviewInput, req.body);
    return withTx(app.db, async (tx) => {
      const ev = (await tx.query(`SELECT * FROM attendance_events WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [id, p.orgId])).rows[0];
      if (!ev) throw notFound("Attendance record");
      const emp = await loadEmployee(tx, p.orgId, ev.employee_id);
      const s = scopeOf(p, "attendance.approve");
      if (!s || !scopeCovers(p, s, scopedRecord(emp))) throw notFound("Attendance record");
      requireReviewer(p, emp);
      if (ev.result !== "pending_exception") throw conflict("This record has already been reviewed");
      const result = input.decision === "approve" ? "approved_exception" : "rejected";
      const row = (
        await tx.query(
          `UPDATE attendance_events SET result = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1
           RETURNING id, employee_id, to_char(work_date,'YYYY-MM-DD') AS work_date, kind, mode, server_time, latitude, longitude, accuracy_m, distance_m, result, flags, note, review_note, reviewed_at`,
          [id, result, p.userId, input.note ?? null],
        )
      ).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: `attendance.exception.${input.decision}`, entityType: "attendance_event", entityId: String(id), before: { result: ev.result }, after: { result, note: input.note }, ...reqMeta(req) });
      await notify(tx, p.orgId, emp.user_id, "attendance.reviewed", input.decision === "approve" ? "Attendance exception approved" : "Attendance exception rejected", input.note ?? "", "attendance_event", String(id));
      await rebuildLedger(tx, p.orgId, [emp.id], row.work_date, row.work_date);
      return eventDto(row);
    });
  });

  // ── Corrections ───────────────────────────────────────────────────────────
  app.post("/attendance/corrections", async (req, reply) => {
    const p = req.principal;
    const input = parse(CorrectionInput, req.body);
    const forOther = input.employeeId && input.employeeId !== p.employeeId;
    const out = await withTx(app.db, async (tx) => {
      const emp = await loadEmployee(tx, p.orgId, forOther ? input.employeeId! : selfEmployeeId(p));
      const today = dateInZone(new Date(), emp.timezone);
      if (input.workDate > today) throw badRequest("You cannot correct a future date");
      for (const t of [input.checkInAt, input.checkOutAt]) {
        if (!t) continue;
        const d = dateInZone(new Date(t), emp.timezone);
        if (d !== input.workDate && d !== addDays(input.workDate, 1)) throw badRequest("Times must fall on the work date (or the early hours after it)");
        if (new Date(t) > new Date()) throw badRequest("Times cannot be in the future");
      }
      if (forOther) {
        // Manual entry by an approver is effective immediately and fully audited.
        const s = scopeOf(p, "attendance.approve");
        if (!s || !scopeCovers(p, s, scopedRecord(emp))) throw notFound("Employee");
        requireReviewer(p, emp);
      } else {
        requirePermission(p, "attendance.self");
        if (input.workDate < addDays(today, -CORRECTION_WINDOW_DAYS)) throw badRequest(`Corrections can be requested for the last ${CORRECTION_WINDOW_DAYS} days only`);
        const open = await tx.query(`SELECT 1 FROM attendance_corrections WHERE employee_id = $1 AND work_date = $2 AND status = 'pending'`, [emp.id, input.workDate]);
        if (open.rowCount) throw conflict("You already have a pending correction for this date");
      }
      const row = (
        await tx.query(
          `INSERT INTO attendance_corrections (organisation_id, employee_id, work_date, check_in_at, check_out_at, mode, reason, kind, status, requested_by, decided_by, decided_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *, to_char(work_date,'YYYY-MM-DD') AS work_date`,
          [p.orgId, emp.id, input.workDate, input.checkInAt ?? null, input.checkOutAt ?? null, input.mode, input.reason,
            forOther ? "manual" : "request", forOther ? "approved" : "pending", p.userId, forOther ? p.userId : null, forOther ? new Date() : null],
        )
      ).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: forOther ? "attendance.manual_entry" : "attendance.correction.request", entityType: "attendance_correction", entityId: row.id, after: input, ...reqMeta(req) });
      if (forOther) {
        await notify(tx, p.orgId, emp.user_id, "attendance.manual", `Attendance for ${input.workDate} was updated`, input.reason, "attendance_correction", row.id);
        await rebuildLedger(tx, p.orgId, [emp.id], input.workDate, input.workDate);
      } else {
        await notify(tx, p.orgId, emp.manager_user_id, "attendance.correction", `${emp.full_name} asked for an attendance correction`, `${input.workDate}: ${input.reason}`, "attendance_correction", row.id);
      }
      return row;
    });
    return reply.status(201).send(correctionDto(out));
  });

  app.get("/attendance/corrections", async (req) => {
    const p = req.principal;
    const { view, status } = parse(z.object({ view: z.enum(["mine", "review"]).default("mine"), status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional() }), req.query);
    const params: unknown[] = [p.orgId];
    const where = [`c.organisation_id = $1`];
    if (view === "mine") {
      where.push(`e.user_id = $${params.push(p.userId)}`);
    } else {
      const scope = requirePermission(p, "attendance.approve");
      where.push(`e.user_id <> $${params.push(p.userId)}`, employeeScopeSql(p, scope, params));
    }
    if (status) where.push(`c.status = $${params.push(status)}`);
    const r = await app.db.query(
      `SELECT c.*, to_char(c.work_date,'YYYY-MM-DD') AS work_date, e.full_name, e.employee_code FROM attendance_corrections c
         JOIN employees e ON e.id = c.employee_id LEFT JOIN employees m ON m.id = e.reporting_manager_id
        WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT 200`,
      params,
    );
    return { items: r.rows.map(correctionDto) };
  });

  app.post("/attendance/corrections/:id/review", async (req) => {
    const p = req.principal;
    const { id } = parse(IdParam, req.params);
    const input = parse(ReviewInput, req.body);
    return withTx(app.db, async (tx) => {
      const c = (await tx.query(`SELECT *, to_char(work_date,'YYYY-MM-DD') AS work_date FROM attendance_corrections WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [id, p.orgId])).rows[0];
      if (!c) throw notFound("Correction");
      const emp = await loadEmployee(tx, p.orgId, c.employee_id);
      const s = scopeOf(p, "attendance.approve");
      if (!s || !scopeCovers(p, s, scopedRecord(emp))) throw notFound("Correction");
      requireReviewer(p, emp);
      if (c.status !== "pending") throw conflict("This correction has already been decided");
      const status = input.decision === "approve" ? "approved" : "rejected";
      const row = (
        await tx.query(
          `UPDATE attendance_corrections SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *, to_char(work_date,'YYYY-MM-DD') AS work_date`,
          [id, status, p.userId, input.note ?? null],
        )
      ).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: `attendance.correction.${input.decision}`, entityType: "attendance_correction", entityId: id, before: { status: c.status }, after: { status, note: input.note }, ...reqMeta(req) });
      await notify(tx, p.orgId, emp.user_id, "attendance.correction.decided", `Correction for ${c.work_date} ${status}`, input.note ?? "", "attendance_correction", id);
      await rebuildLedger(tx, p.orgId, [emp.id], c.work_date, c.work_date);
      return correctionDto(row);
    });
  });

  app.post("/attendance/corrections/:id/withdraw", async (req) => {
    const p = req.principal;
    const { id } = parse(IdParam, req.params);
    const r = await app.db.query(
      `UPDATE attendance_corrections c SET status = 'withdrawn' FROM employees e
        WHERE c.id = $1 AND c.organisation_id = $2 AND e.id = c.employee_id AND e.user_id = $3 AND c.status = 'pending'
        RETURNING c.*, to_char(c.work_date,'YYYY-MM-DD') AS work_date`,
      [id, p.orgId, p.userId],
    );
    if (!r.rows[0]) throw notFound("Pending correction");
    return correctionDto(r.rows[0]);
  });

  // ── Configuration: geofences, policy, holidays ────────────────────────────
  app.get("/attendance/geofences", async (req) => {
    const p = req.principal;
    requirePermission(p, "attendance.configure");
    const r = await app.db.query(
      `SELECT b.id AS branch_id, b.code, b.name, b.timezone, g.latitude, g.longitude, g.radius_m, g.max_accuracy_m, g.active, g.updated_at
         FROM branches b LEFT JOIN geofences g ON g.branch_id = b.id WHERE b.organisation_id = $1 ORDER BY b.code`,
      [p.orgId],
    );
    return {
      items: r.rows.map((x) => ({
        branchId: x.branch_id, code: x.code, name: x.name, timezone: x.timezone,
        geofence: x.latitude === null ? null : { latitude: Number(x.latitude), longitude: Number(x.longitude), radiusM: x.radius_m, maxAccuracyM: x.max_accuracy_m, active: x.active, updatedAt: x.updated_at },
      })),
    };
  });

  app.put("/attendance/geofences/:id", async (req) => {
    const p = req.principal;
    requirePermission(p, "attendance.configure", "org");
    const { id: branchId } = parse(IdParam, req.params);
    const input = parse(GeofenceInput, req.body);
    return withTx(app.db, async (tx) => {
      const b = (await tx.query(`SELECT id FROM branches WHERE id = $1 AND organisation_id = $2`, [branchId, p.orgId])).rows[0];
      if (!b) throw notFound("Branch");
      const before = (await tx.query(`SELECT latitude, longitude, radius_m, max_accuracy_m, active FROM geofences WHERE branch_id = $1`, [branchId])).rows[0];
      const g = (
        await tx.query(
          `INSERT INTO geofences (organisation_id, branch_id, latitude, longitude, radius_m, max_accuracy_m, active, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (branch_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, radius_m = EXCLUDED.radius_m,
             max_accuracy_m = EXCLUDED.max_accuracy_m, active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING *`,
          [p.orgId, branchId, input.latitude, input.longitude, input.radiusM, input.maxAccuracyM, input.active, p.userId],
        )
      ).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "attendance.geofence.set", entityType: "branch", entityId: branchId, before: before ?? null, after: input, ...reqMeta(req) });
      return { branchId, latitude: Number(g.latitude), longitude: Number(g.longitude), radiusM: g.radius_m, maxAccuracyM: g.max_accuracy_m, active: g.active };
    });
  });

  app.get("/attendance/policy", async (req) => {
    const p = req.principal;
    const { branchId } = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    const b = branchId ?? p.branchId;
    if (!b) throw badRequest("branchId is required");
    if (b !== p.branchId) requirePermission(p, "attendance.configure");
    return policyFor(app.db, p.orgId, b);
  });

  app.put("/attendance/policy", async (req) => {
    const p = req.principal;
    requirePermission(p, "attendance.configure", "org");
    const body = req.body as Record<string, unknown> | null;
    const branchId = body?.branchId ? z.string().uuid().parse(body.branchId) : null;
    const input = parse(PolicyInput, body);
    return withTx(app.db, async (tx) => {
      if (branchId) {
        const b = await tx.query(`SELECT 1 FROM branches WHERE id = $1 AND organisation_id = $2`, [branchId, p.orgId]);
        if (!b.rowCount) throw notFound("Branch");
      }
      const existing = (
        await tx.query(`SELECT * FROM attendance_policies WHERE organisation_id = $1 AND branch_id IS NOT DISTINCT FROM $2 FOR UPDATE`, [p.orgId, branchId])
      ).rows[0];
      const vals = [input.workStart, input.workEnd, input.graceMinutes, input.earlyLeaveMinutes, input.halfDayMinutes, input.fullDayMinutes, input.weeklyOffs, input.allowWfh, input.allowField, p.userId];
      if (existing) {
        await tx.query(
          `UPDATE attendance_policies SET work_start=$2, work_end=$3, grace_minutes=$4, early_leave_minutes=$5, half_day_minutes=$6, full_day_minutes=$7,
             weekly_offs=$8, allow_wfh=$9, allow_field=$10, updated_by=$11, updated_at=now() WHERE id = $1`,
          [existing.id, ...vals],
        );
      } else {
        await tx.query(
          `INSERT INTO attendance_policies (organisation_id, branch_id, work_start, work_end, grace_minutes, early_leave_minutes, half_day_minutes, full_day_minutes, weekly_offs, allow_wfh, allow_field, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [p.orgId, branchId, ...vals],
        );
      }
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "attendance.policy.set", entityType: branchId ? "branch" : "organisation", entityId: branchId ?? p.orgId, before: existing ?? null, after: input, ...reqMeta(req) });
      return policyFor(tx, p.orgId, branchId ?? p.branchId ?? "00000000-0000-0000-0000-000000000000");
    });
  });

  app.get("/holidays", async (req) => {
    const p = req.principal;
    const { year } = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) }), req.query);
    const r = await app.db.query(
      `SELECT h.id, to_char(h.holiday_date,'YYYY-MM-DD') AS holiday_date, h.name, h.optional, h.branch_id, b.name AS branch_name
         FROM holidays h LEFT JOIN branches b ON b.id = h.branch_id
        WHERE h.organisation_id = $1 AND extract(year FROM h.holiday_date) = $2 ORDER BY h.holiday_date`,
      [p.orgId, year],
    );
    return { items: r.rows };
  });

  app.post("/holidays", async (req, reply) => {
    const p = req.principal;
    requirePermission(p, "attendance.configure", "org");
    const input = parse(HolidayInput, req.body);
    const row = await withTx(app.db, async (tx) => {
      if (input.branchId) {
        const b = await tx.query(`SELECT 1 FROM branches WHERE id = $1 AND organisation_id = $2`, [input.branchId, p.orgId]);
        if (!b.rowCount) throw notFound("Branch");
      }
      const r = (
        await tx.query(
          `INSERT INTO holidays (organisation_id, branch_id, holiday_date, name, optional) VALUES ($1,$2,$3,$4,$5)
           RETURNING id, to_char(holiday_date,'YYYY-MM-DD') AS holiday_date, name, optional, branch_id`,
          [p.orgId, input.branchId ?? null, input.holidayDate, input.name, input.optional],
        )
      ).rows[0];
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "holiday.create", entityType: "holiday", entityId: r.id, after: input, ...reqMeta(req) });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.delete("/holidays/:id", async (req, reply) => {
    const p = req.principal;
    requirePermission(p, "attendance.configure", "org");
    const { id } = parse(IdParam, req.params);
    await withTx(app.db, async (tx) => {
      const r = (await tx.query(`DELETE FROM holidays WHERE id = $1 AND organisation_id = $2 RETURNING *`, [id, p.orgId])).rows[0];
      if (!r) throw notFound("Holiday");
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "holiday.delete", entityType: "holiday", entityId: id, before: r, ...reqMeta(req) });
    });
    return reply.status(204).send();
  });
}

function correctionDto(r: Record<string, unknown>) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.full_name ?? undefined,
    employeeCode: r.employee_code ?? undefined,
    workDate: r.work_date,
    checkInAt: r.check_in_at,
    checkOutAt: r.check_out_at,
    mode: r.mode,
    reason: r.reason,
    kind: r.kind,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

type DayRow = { status: string; worked_minutes: number; late_minutes: number; needs_review: boolean };
export function summarise(days: DayRow[]) {
  const count = (s: string) => days.filter((d) => d.status === s).length;
  return {
    present: count("present") + count("late") + count("wfh") + count("field"),
    late: count("late"),
    halfDay: count("half_day") + count("half_day_leave"),
    absent: count("absent"),
    onLeave: count("on_leave"),
    holidays: count("holiday"),
    weeklyOffs: count("weekly_off"),
    needsReview: days.filter((d) => d.needs_review).length,
    workedMinutes: days.reduce((a, d) => a + d.worked_minutes, 0),
  };
}

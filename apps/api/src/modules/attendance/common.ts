import {
  addDays,
  dateInZone,
  eachDate,
  summariseDay,
  type AttendanceMode,
  type DayEvent,
  type EventResult,
  type PolicyRule,
} from "@rstar/shared";
import type { Queryable } from "../../db.js";
import { notFound } from "../../errors.js";
import type { Principal, ScopedRecord } from "../../auth/principal.js";

export const DEFAULT_POLICY: PolicyRule = {
  workStart: "09:30",
  workEnd: "18:30",
  graceMinutes: 15,
  earlyLeaveMinutes: 15,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  weeklyOffs: [0],
  allowWfh: false,
  allowField: true,
};

export function policyFromRow(r: Record<string, unknown> | undefined): PolicyRule {
  if (!r) return DEFAULT_POLICY;
  return {
    workStart: String(r.work_start).slice(0, 5),
    workEnd: String(r.work_end).slice(0, 5),
    graceMinutes: Number(r.grace_minutes),
    earlyLeaveMinutes: Number(r.early_leave_minutes),
    halfDayMinutes: Number(r.half_day_minutes),
    fullDayMinutes: Number(r.full_day_minutes),
    weeklyOffs: (r.weekly_offs as number[]).map(Number),
    allowWfh: Boolean(r.allow_wfh),
    allowField: Boolean(r.allow_field),
  };
}

/** Effective policy for a branch: branch override, else organisation default, else built-in default. */
export async function policyFor(q: Queryable, orgId: string, branchId: string): Promise<PolicyRule & { source: "branch" | "organisation" | "default" }> {
  const r = (
    await q.query(
      `SELECT *, CASE WHEN branch_id IS NULL THEN 'organisation' ELSE 'branch' END AS source
         FROM attendance_policies WHERE organisation_id = $1 AND (branch_id = $2 OR branch_id IS NULL)
        ORDER BY branch_id NULLS LAST LIMIT 1`,
      [orgId, branchId],
    )
  ).rows[0];
  return { ...policyFromRow(r), source: r ? r.source : "default" };
}

export interface EmployeeRec {
  id: string;
  user_id: string;
  full_name: string;
  employee_code: string;
  branch_id: string;
  department_id: string;
  timezone: string;
  joining_date: string;
  exit_date: string | null;
  manager_user_id: string | null;
  location_consent_at: Date | null;
}

const EMP_SQL = `SELECT e.id, e.user_id, e.full_name, e.employee_code, e.branch_id, e.department_id, b.timezone,
       to_char(e.joining_date,'YYYY-MM-DD') AS joining_date, to_char(e.exit_date,'YYYY-MM-DD') AS exit_date,
       m.user_id AS manager_user_id, e.location_consent_at
  FROM employees e JOIN branches b ON b.id = e.branch_id LEFT JOIN employees m ON m.id = e.reporting_manager_id`;

export async function loadEmployee(q: Queryable, orgId: string, employeeId: string): Promise<EmployeeRec> {
  const r = (await q.query(`${EMP_SQL} WHERE e.id = $1 AND e.organisation_id = $2`, [employeeId, orgId])).rows[0];
  if (!r) throw notFound("Employee");
  return r;
}

export async function loadEmployees(q: Queryable, orgId: string, ids: string[]): Promise<EmployeeRec[]> {
  if (!ids.length) return [];
  return (await q.query(`${EMP_SQL} WHERE e.id = ANY($1) AND e.organisation_id = $2`, [ids, orgId])).rows;
}

export function scopedRecord(e: EmployeeRec): ScopedRecord {
  return { branchId: e.branch_id, departmentId: e.department_id, userIds: [e.user_id], managerUserIds: e.manager_user_id ? [e.manager_user_id] : [] };
}

export function selfEmployeeId(p: Principal): string {
  if (!p.employeeId) throw notFound("Employee profile");
  return p.employeeId;
}

export async function notify(q: Queryable, orgId: string, userId: string | null, kind: string, title: string, body: string, entityType: string, entityId: string) {
  if (!userId) return;
  await q.query(
    `INSERT INTO notifications (organisation_id, user_id, kind, title, body, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, userId, kind, title, body, entityType, entityId],
  );
}

/** Set of non-working dates (holidays + weekly offs) for a branch between two dates. */
export async function nonWorkingChecker(q: Queryable, orgId: string, branchId: string, from: string, to: string) {
  const policy = await policyFor(q, orgId, branchId);
  const hol = await q.query(
    `SELECT to_char(holiday_date,'YYYY-MM-DD') AS d FROM holidays
      WHERE organisation_id = $1 AND (branch_id IS NULL OR branch_id = $2) AND NOT optional AND holiday_date BETWEEN $3 AND $4`,
    [orgId, branchId, from, to],
  );
  const set = new Set<string>(hol.rows.map((r) => r.d));
  return (date: string) => set.has(date) || policy.weeklyOffs.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
}

/**
 * Recompute the daily ledger for employees over [from, to] (capped at each branch's "today").
 * Pure function of events + approved corrections + approved leave + holidays + policy, so it is
 * safe to call repeatedly. Batched: a fixed number of queries regardless of the range size.
 */
export async function rebuildLedger(q: Queryable, orgId: string, employeeIds: string[], from: string, to: string, now = new Date()) {
  const emps = await loadEmployees(q, orgId, employeeIds);
  if (!emps.length) return;
  const ids = emps.map((e) => e.id);

  const [events, corrections, leaves, holidays, policies] = await Promise.all([
    q.query(
      `SELECT employee_id, to_char(work_date,'YYYY-MM-DD') AS d, kind, mode, server_time, result FROM attendance_events
        WHERE employee_id = ANY($1) AND work_date BETWEEN $2 AND $3 AND kind IN ('check_in','check_out')`,
      [ids, from, to],
    ),
    q.query(
      `SELECT DISTINCT ON (employee_id, work_date) employee_id, to_char(work_date,'YYYY-MM-DD') AS d, check_in_at, check_out_at, mode
         FROM attendance_corrections WHERE employee_id = ANY($1) AND work_date BETWEEN $2 AND $3 AND status = 'approved'
        ORDER BY employee_id, work_date, decided_at DESC`,
      [ids, from, to],
    ),
    q.query(
      `SELECT id, employee_id, to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e, start_half, end_half
         FROM leave_requests WHERE employee_id = ANY($1) AND status = 'approved' AND start_date <= $3 AND end_date >= $2`,
      [ids, from, to],
    ),
    q.query(
      `SELECT branch_id, to_char(holiday_date,'YYYY-MM-DD') AS d FROM holidays
        WHERE organisation_id = $1 AND NOT optional AND holiday_date BETWEEN $2 AND $3`,
      [orgId, from, to],
    ),
    q.query(`SELECT * FROM attendance_policies WHERE organisation_id = $1`, [orgId]),
  ]);

  const orgPolicy = policies.rows.find((r) => r.branch_id === null);
  const policyByBranch = (b: string) => policyFromRow(policies.rows.find((r) => r.branch_id === b) ?? orgPolicy);
  const key = (e: string, d: string) => `${e}|${d}`;
  const evMap = new Map<string, DayEvent[]>();
  for (const r of events.rows) {
    const k = key(r.employee_id, r.d);
    if (!evMap.has(k)) evMap.set(k, []);
    evMap.get(k)!.push({ kind: r.kind, mode: r.mode as AttendanceMode, at: new Date(r.server_time), result: r.result as EventResult });
  }
  const corrMap = new Map(corrections.rows.map((r) => [key(r.employee_id, r.d), r]));

  const rows: unknown[][] = [];
  for (const emp of emps) {
    const policy = policyByBranch(emp.branch_id);
    const today = dateInZone(now, emp.timezone);
    const start = from > emp.joining_date ? from : emp.joining_date;
    let end = to < today ? to : today;
    if (emp.exit_date && emp.exit_date < end) end = emp.exit_date;
    if (start > end) continue;
    const hol = new Set(holidays.rows.filter((h) => h.branch_id === null || h.branch_id === emp.branch_id).map((h) => h.d));
    const myLeaves = leaves.rows.filter((l) => l.employee_id === emp.id);
    for (const date of eachDate(start, end)) {
      const lv = myLeaves.find((l) => l.s <= date && l.e >= date);
      const leave = lv ? ((date === lv.s && lv.start_half) || (date === lv.e && lv.end_half) ? "half" : "full") : null;
      const c = corrMap.get(key(emp.id, date));
      const s = summariseDay({
        date,
        timeZone: emp.timezone,
        policy,
        events: evMap.get(key(emp.id, date)) ?? [],
        holiday: hol.has(date),
        leave,
        correction: c ? { checkInAt: c.check_in_at, checkOutAt: c.check_out_at, mode: c.mode } : null,
        today,
      });
      rows.push([emp.id, date, orgId, emp.branch_id, s.status, s.firstIn, s.lastOut, s.workedMinutes, s.lateMinutes, s.earlyMinutes, s.source, s.needsReview, lv?.id ?? null]);
    }
  }

  // Upsert in chunks to keep statements a sensible size.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params: unknown[] = [];
    const values = chunk.map((r) => {
      const base = params.length;
      params.push(...r);
      return `(${r.map((_, j) => `$${base + j + 1}`).join(",")})`;
    });
    await q.query(
      `INSERT INTO attendance_days (employee_id, work_date, organisation_id, branch_id, status, first_in, last_out, worked_minutes, late_minutes, early_minutes, source, needs_review, leave_request_id)
       VALUES ${values.join(",")}
       ON CONFLICT (employee_id, work_date) DO UPDATE SET branch_id = EXCLUDED.branch_id, status = EXCLUDED.status, first_in = EXCLUDED.first_in,
         last_out = EXCLUDED.last_out, worked_minutes = EXCLUDED.worked_minutes, late_minutes = EXCLUDED.late_minutes,
         early_minutes = EXCLUDED.early_minutes, source = EXCLUDED.source, needs_review = EXCLUDED.needs_review,
         leave_request_id = EXCLUDED.leave_request_id, updated_at = now()`,
      params,
    );
  }
}

export function clampRange(from: string | undefined, to: string | undefined, today: string, maxDays = 62) {
  const t = to ?? today;
  const f = from ?? `${t.slice(0, 8)}01`;
  if (f > t) return { from: t, to: f };
  const limit = addDays(f, maxDays - 1);
  return { from: f, to: t > limit ? limit : t };
}

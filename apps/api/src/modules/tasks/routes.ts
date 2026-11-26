import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  TaskCommentInput,
  TaskCreateInput,
  TaskStatusInput,
  TaskUpdateInput,
  canSetTaskStatus,
  type TaskStatus,
} from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requirePermission, scopeCovers, scopeOf, type Principal } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { withTx, type Queryable } from "../../db.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { employeeScopeSql } from "../employees/routes.js";
import { loadEmployee, notify, scopedRecord, type EmployeeRec } from "../attendance/common.js";

const IdParam = z.object({ id: z.string().uuid() });
const ACTIVE: TaskStatus[] = ["open", "in_progress", "blocked"];
const ListQuery = z.object({
  view: z.enum(["mine", "created", "team"]).default("mine"),
  status: z.string().optional(), // "active" (default), "all", or a comma list
  overdue: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(100).optional(),
  assignee: z.string().uuid().optional(),
});

const SELECT = `SELECT t.*, to_char(t.due_date,'YYYY-MM-DD') AS due_date,
    e.full_name AS assignee_name, e.employee_code AS assignee_code, e.user_id AS assignee_user_id,
    cu.display_name AS creator_name, ci.content_code, ci.title AS content_title,
    (t.due_date IS NOT NULL AND t.status IN ('open','in_progress','blocked')
      AND t.due_date < (now() AT TIME ZONE b.timezone)::date) AS overdue
  FROM tasks t JOIN employees e ON e.id = t.assignee_employee_id JOIN branches b ON b.id = e.branch_id
  LEFT JOIN employees m ON m.id = e.reporting_manager_id
  JOIN users cu ON cu.id = t.created_by LEFT JOIN content_items ci ON ci.id = t.content_item_id`;

function dto(r: Record<string, unknown>, p: Principal, rights?: Rights) {
  return {
    id: r.id, number: Number(r.task_no), title: r.title, description: r.description,
    assignee: { employeeId: r.assignee_employee_id, name: r.assignee_name, code: r.assignee_code, isMe: r.assignee_user_id === p.userId },
    createdBy: { name: r.creator_name, isMe: r.created_by === p.userId },
    priority: r.priority, status: r.status, dueDate: r.due_date, overdue: Boolean(r.overdue),
    content: r.content_code ? { code: r.content_code, title: r.content_title } : null,
    startedAt: r.started_at, completedAt: r.completed_at, createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
    ...(rights ? { can: rights } : {}),
  };
}

interface Rights { work: boolean; manage: boolean; comment: boolean }

function requireStaff(p: Principal) {
  if (p.kind !== "staff") throw forbidden();
  requirePermission(p, "tasks.self");
}

/** True when the caller manages `emp` for tasks (a direct report, department, branch or org, depending on scope). */
function managesEmployee(p: Principal, emp: EmployeeRec): boolean {
  const s = scopeOf(p, "tasks.manage");
  return Boolean(s && emp.user_id !== p.userId && scopeCovers(p, s, scopedRecord(emp)));
}

async function loadTask(q: Queryable, p: Principal, id: string, lock = false) {
  const r = (await q.query(`${SELECT} WHERE t.id = $1 AND t.organisation_id = $2 ${lock ? "FOR UPDATE OF t" : ""}`, [id, p.orgId])).rows[0];
  if (!r) throw notFound("Task");
  const emp = await loadEmployee(q, p.orgId, r.assignee_employee_id);
  const isAssignee = emp.user_id === p.userId;
  const isCreator = r.created_by === p.userId;
  const manage = isCreator || managesEmployee(p, emp);
  // Out-of-scope tasks are reported as missing, not forbidden.
  if (!isAssignee && !manage) throw notFound("Task");
  const rights: Rights = { work: isAssignee || manage, manage, comment: true };
  return { row: r, emp, rights };
}

async function resolveAssignee(q: Queryable, p: Principal, employeeId: string | undefined) {
  if (!employeeId) {
    if (!p.employeeId) throw badRequest("Choose who the task is for");
    employeeId = p.employeeId;
  }
  const emp = await loadEmployee(q, p.orgId, employeeId).catch(() => {
    throw badRequest("That person was not found");
  });
  const status = (await q.query("SELECT status FROM employees WHERE id = $1", [emp.id])).rows[0]?.status;
  if (status === "exited" || status === "archived") throw badRequest("That person has left the organisation");
  if (emp.user_id !== p.userId && !managesEmployee(p, emp)) throw forbidden("You can only assign tasks to people you manage");
  return emp;
}

async function contentIdFor(q: Queryable, orgId: string, code: string | null | undefined) {
  if (!code) return null;
  const r = (await q.query("SELECT id FROM content_items WHERE organisation_id = $1 AND upper(content_code) = upper($2)", [orgId, code])).rows[0];
  if (!r) throw badRequest(`No content item with ID ${code}`);
  return r.id as string;
}

const event = (q: Queryable, taskId: string, actor: string, kind: string, from: string | null, to: string | null, note?: string | null) =>
  q.query("INSERT INTO task_events (task_id, actor_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,$4,$5,$6)", [taskId, actor, kind, from, to, note ?? null]);

export async function taskRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /** People the caller can assign tasks to: themselves plus everyone their tasks.manage scope covers. */
  app.get("/tasks/assignees", async (req) => {
    const p = req.principal;
    requireStaff(p);
    const s = scopeOf(p, "tasks.manage");
    const params: unknown[] = [p.orgId];
    const scope = s ? employeeScopeSql(p, s, params) : `e.user_id = $${params.push(p.userId)}`;
    const r = await app.db.query(
      `SELECT e.id, e.full_name, e.employee_code, d.name AS department, e.user_id FROM employees e
         LEFT JOIN employees m ON m.id = e.reporting_manager_id JOIN departments d ON d.id = e.department_id
        WHERE e.organisation_id = $1 AND e.status NOT IN ('exited','archived') AND ${scope}
        ORDER BY (e.user_id = $${params.push(p.userId)}) DESC, e.full_name LIMIT 500`,
      params,
    );
    return { items: r.rows.map((x) => ({ employeeId: x.id, name: x.full_name, code: x.employee_code, department: x.department, isMe: x.user_id === p.userId })) };
  });

  app.get("/tasks/summary", async (req) => {
    const p = req.principal;
    requireStaff(p);
    const mine = (
      await app.db.query(
        `SELECT count(*) FILTER (WHERE t.status IN ('open','in_progress','blocked')) AS open,
                count(*) FILTER (WHERE t.status IN ('open','in_progress','blocked') AND t.due_date < (now() AT TIME ZONE b.timezone)::date) AS overdue,
                count(*) FILTER (WHERE t.status IN ('open','in_progress','blocked') AND t.due_date = (now() AT TIME ZONE b.timezone)::date) AS due_today
           FROM tasks t JOIN employees e ON e.id = t.assignee_employee_id JOIN branches b ON b.id = e.branch_id
          WHERE t.organisation_id = $1 AND e.user_id = $2`,
        [p.orgId, p.userId],
      )
    ).rows[0];
    return { open: Number(mine.open), overdue: Number(mine.overdue), dueToday: Number(mine.due_today) };
  });

  app.get("/tasks", async (req) => {
    const p = req.principal;
    requireStaff(p);
    const f = parse(ListQuery, req.query);
    const params: unknown[] = [p.orgId];
    const where = ["t.organisation_id = $1"];
    if (f.view === "mine") where.push(`e.user_id = $${params.push(p.userId)}`);
    else if (f.view === "created") where.push(`t.created_by = $${params.push(p.userId)}`, `e.user_id <> $${params.push(p.userId)}`);
    else {
      const s = scopeOf(p, "tasks.manage");
      if (!s) throw forbidden();
      where.push(`e.user_id <> $${params.push(p.userId)}`, employeeScopeSql(p, s, params));
    }
    const statuses =
      !f.status || f.status === "active" ? ACTIVE : f.status === "all" ? [...TASK_STATUSES] : f.status.split(",").filter((x): x is TaskStatus => (TASK_STATUSES as readonly string[]).includes(x));
    if (!statuses.length) throw badRequest("Unknown status filter");
    where.push(`t.status = ANY($${params.push(statuses)})`);
    if (f.overdue === "true") where.push(`t.due_date < (now() AT TIME ZONE b.timezone)::date AND t.status IN ('open','in_progress','blocked')`);
    if (f.assignee) where.push(`t.assignee_employee_id = $${params.push(f.assignee)}`);
    if (f.q) {
      const n = f.q.replace(/^#?T-?/i, "");
      where.push(/^\d+$/.test(n) ? `t.task_no = $${params.push(Number(n))}` : `t.title ILIKE $${params.push(`%${f.q.replace(/[%_\\]/g, "\\$&")}%`)}`);
    }
    const r = await app.db.query(
      `${SELECT} WHERE ${where.join(" AND ")}
        ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'open' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
                 t.due_date NULLS LAST, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC
        LIMIT 300`,
      params,
    );
    return { items: r.rows.map((x) => dto(x, p)) };
  });

  app.post("/tasks", async (req, reply) => {
    const p = req.principal;
    requireStaff(p);
    const b = parse(TaskCreateInput, req.body);
    const out = await withTx(app.db, async (tx) => {
      const emp = await resolveAssignee(tx, p, b.assigneeEmployeeId);
      const contentId = await contentIdFor(tx, p.orgId, b.contentCode);
      const t = (
        await tx.query(
          `INSERT INTO tasks (organisation_id, title, description, assignee_employee_id, created_by, priority, due_date, content_item_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, task_no`,
          [p.orgId, b.title, b.description, emp.id, p.userId, b.priority, b.dueDate ?? null, contentId],
        )
      ).rows[0];
      await event(tx, t.id, p.userId, "created", null, emp.full_name);
      if (emp.user_id !== p.userId) {
        await notify(tx, p.orgId, emp.user_id, "task.assigned", `New task T-${t.task_no}: ${b.title}`,
          `${p.displayName} assigned you a task${b.dueDate ? `, due ${b.dueDate}` : ""}.`, "task", t.id);
      }
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "task.create", entityType: "task", entityId: t.id, after: { ...b, assigneeEmployeeId: emp.id }, ...reqMeta(req) });
      return (await loadTask(tx, p, t.id)).row;
    });
    return reply.status(201).send(dto(out, p));
  });

  app.get("/tasks/:id", async (req) => {
    const p = req.principal;
    requireStaff(p);
    const { id } = parse(IdParam, req.params);
    const { row, rights } = await loadTask(app.db, p, id);
    const [comments, events] = await Promise.all([
      app.db.query(
        `SELECT c.id, c.body, c.created_at, u.display_name, c.author_user_id FROM task_comments c JOIN users u ON u.id = c.author_user_id
          WHERE c.task_id = $1 ORDER BY c.created_at`,
        [id],
      ),
      app.db.query(
        `SELECT ev.id, ev.kind, ev.from_value, ev.to_value, ev.note, ev.created_at, u.display_name FROM task_events ev JOIN users u ON u.id = ev.actor_id
          WHERE ev.task_id = $1 ORDER BY ev.id`,
        [id],
      ),
    ]);
    return {
      ...dto(row, p, rights),
      comments: comments.rows.map((c) => ({ id: c.id, body: c.body, author: c.display_name, isMine: c.author_user_id === p.userId, createdAt: c.created_at })),
      history: events.rows.map((e) => ({ id: Number(e.id), kind: e.kind, from: e.from_value, to: e.to_value, note: e.note, actor: e.display_name, at: e.created_at })),
    };
  });

  app.patch("/tasks/:id", async (req) => {
    const p = req.principal;
    requireStaff(p);
    const { id } = parse(IdParam, req.params);
    const b = parse(TaskUpdateInput, req.body);
    const out = await withTx(app.db, async (tx) => {
      const { row, emp, rights } = await loadTask(tx, p, id, true);
      if (!rights.manage) throw forbidden("Only the person who assigned this task, or their manager, can edit it");
      if (row.version !== b.expectedVersion) throw conflict("This task was changed by someone else. Reload and try again.");
      if (row.status === "cancelled" || row.status === "done") throw conflict("Reopen the task before editing it");
      const sets: string[] = [];
      const params: unknown[] = [id];
      const changed: Record<string, unknown> = {};
      if (b.title !== undefined && b.title !== row.title) { sets.push(`title = $${params.push(b.title)}`); changed.title = b.title; }
      if (b.description !== undefined && b.description !== row.description) { sets.push(`description = $${params.push(b.description)}`); changed.description = true; }
      if (b.priority !== undefined && b.priority !== row.priority) { sets.push(`priority = $${params.push(b.priority)}`); changed.priority = b.priority; }
      if (b.dueDate !== undefined && b.dueDate !== row.due_date) { sets.push(`due_date = $${params.push(b.dueDate)}`); changed.dueDate = b.dueDate; }
      let newEmp: EmployeeRec | null = null;
      if (b.assigneeEmployeeId && b.assigneeEmployeeId !== row.assignee_employee_id) {
        newEmp = await resolveAssignee(tx, p, b.assigneeEmployeeId);
        sets.push(`assignee_employee_id = $${params.push(newEmp.id)}`);
        changed.assignee = newEmp.full_name;
      }
      if (!sets.length) return row;
      await tx.query(`UPDATE tasks SET ${sets.join(", ")}, version = version + 1 WHERE id = $1`, params);
      if (newEmp) {
        await event(tx, id, p.userId, "assigned", emp.full_name, newEmp.full_name);
        if (newEmp.user_id !== p.userId)
          await notify(tx, p.orgId, newEmp.user_id, "task.assigned", `Task T-${row.task_no} assigned to you: ${b.title ?? row.title}`, `${p.displayName} assigned you this task.`, "task", id);
        if (emp.user_id !== p.userId)
          await notify(tx, p.orgId, emp.user_id, "task.reassigned", `Task T-${row.task_no} moved to ${newEmp.full_name}`, `${p.displayName} reassigned this task.`, "task", id);
      }
      const other = Object.keys(changed).filter((k) => k !== "assignee");
      if (other.length) {
        await event(tx, id, p.userId, "edited", null, other.join(", "));
        const assigneeUser = newEmp?.user_id ?? emp.user_id;
        if ((changed.dueDate !== undefined || changed.priority) && assigneeUser !== p.userId && !newEmp)
          await notify(tx, p.orgId, assigneeUser, "task.updated", `Task T-${row.task_no} updated`,
            [changed.dueDate !== undefined ? `Due date: ${changed.dueDate ?? "none"}` : null, changed.priority ? `Priority: ${changed.priority}` : null].filter(Boolean).join(" · "), "task", id);
      }
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "task.update", entityType: "task", entityId: id, after: changed, ...reqMeta(req) });
      return (await loadTask(tx, p, id)).row;
    });
    return dto(out, p);
  });

  app.post("/tasks/:id/status", async (req) => {
    const p = req.principal;
    requireStaff(p);
    const { id } = parse(IdParam, req.params);
    const b = parse(TaskStatusInput, req.body);
    const out = await withTx(app.db, async (tx) => {
      const { row, emp, rights } = await loadTask(tx, p, id, true);
      if (row.version !== b.expectedVersion) throw conflict("This task was changed by someone else. Reload and try again.");
      const actor = rights.manage ? "manager" : "assignee";
      if (!canSetTaskStatus(row.status, b.status, actor)) {
        throw rights.manage || row.status === b.status
          ? badRequest(`The task is already ${TASK_STATUS_LABEL[b.status as TaskStatus].toLowerCase()}`)
          : forbidden("Only the person who assigned this task can do that");
      }
      await tx.query(
        `UPDATE tasks SET status = $2, version = version + 1,
            started_at = CASE WHEN $2 = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
            completed_at = CASE WHEN $2 = 'done' THEN now() WHEN $2 IN ('open','in_progress','blocked') THEN NULL ELSE completed_at END
          WHERE id = $1`,
        [id, b.status],
      );
      await event(tx, id, p.userId, "status", row.status, b.status, b.note);
      const label = TASK_STATUS_LABEL[b.status as TaskStatus];
      const msg = `${p.displayName} set it to ${label}${b.note ? `: ${b.note}` : "."}`;
      // Tell the other side: the assigner hears about progress, the assignee hears about manager changes.
      if (emp.user_id === p.userId) {
        if (row.created_by !== p.userId) await notify(tx, p.orgId, row.created_by, "task.status", `T-${row.task_no} ${label}: ${row.title}`, msg, "task", id);
      } else {
        await notify(tx, p.orgId, emp.user_id, "task.status", `T-${row.task_no} ${label}: ${row.title}`, msg, "task", id);
      }
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "task.status", entityType: "task", entityId: id, before: { status: row.status }, after: { status: b.status, note: b.note ?? null }, ...reqMeta(req) });
      return (await loadTask(tx, p, id)).row;
    });
    return dto(out, p);
  });

  app.post("/tasks/:id/comments", async (req, reply) => {
    const p = req.principal;
    requireStaff(p);
    const { id } = parse(IdParam, req.params);
    const b = parse(TaskCommentInput, req.body);
    const out = await withTx(app.db, async (tx) => {
      const { row, emp } = await loadTask(tx, p, id);
      const c = (await tx.query("INSERT INTO task_comments (task_id, author_user_id, body) VALUES ($1,$2,$3) RETURNING id, created_at", [id, p.userId, b.body])).rows[0];
      const preview = b.body.length > 140 ? `${b.body.slice(0, 137)}…` : b.body;
      for (const u of new Set([emp.user_id, row.created_by])) {
        if (u !== p.userId) await notify(tx, p.orgId, u, "task.comment", `${p.displayName} commented on T-${row.task_no}`, preview, "task", id);
      }
      return { id: c.id, body: b.body, author: p.displayName, isMine: true, createdAt: c.created_at };
    });
    return reply.status(201).send(out);
  });
}

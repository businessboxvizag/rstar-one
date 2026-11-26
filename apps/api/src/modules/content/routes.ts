import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CONTENT_STAGES,
  CommentInput,
  CreateContentInput,
  Pagination,
  STAGE_LABELS,
  TransitionInput,
  normaliseContentIdQuery,
  type Scope,
} from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requirePermission, scopeCovers, scopeOf, type Principal } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { withTx } from "../../db.js";
import { forbidden, notFound } from "../../errors.js";
import { allocateAndInsert, availableTransitions, canOnContent, transition, type ContentRow } from "./service.js";

const ASSIGNEES = ["stage_owner_id", "producer_id", "script_writer_id", "camera_operator_id", "editor_id", "publisher_id", "created_by"];

function contentScopeSql(p: Principal, scope: Scope, params: unknown[]): string {
  if (p.kind === "client") return `c.client_id = $${params.push(p.clientId)}`;
  if (scope === "org") return "TRUE";
  const me = `$${params.push(p.userId)}`;
  const own = `(${ASSIGNEES.map((a) => `c.${a} = ${me}`).join(" OR ")})`;
  switch (scope) {
    case "branch":
      return `(${own} OR c.branch_id = $${params.push(p.branchId)})`;
    case "department":
      return `(${own} OR c.department_id = $${params.push(p.departmentId)})`;
    case "team":
    case "own":
      return own;
  }
}

const SELECT = `SELECT c.*, cl.name AS client_name, ch.name AS channel_name, b.name AS branch_name, ou.display_name AS stage_owner_name
  FROM content_items c
  LEFT JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN channels ch ON ch.id = c.channel_id
  JOIN branches b ON b.id = c.branch_id
  LEFT JOIN users ou ON ou.id = c.stage_owner_id`;

async function loadVisible(app: FastifyInstance, p: Principal, idOrCode: string): Promise<ContentRow> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrCode);
  const r = await app.db.query<ContentRow>(
    `${SELECT} WHERE c.organisation_id = $1 AND ${isUuid ? "c.id = $2" : "c.content_code = $2"}`,
    [p.orgId, isUuid ? idOrCode : normaliseContentIdQuery(idOrCode)],
  );
  const c = r.rows[0];
  if (!c || !canOnContent(p, "content.read", c)) throw notFound("Content");
  return c;
}

/** Client portal users never see internal fields. */
function present(p: Principal, c: ContentRow) {
  const base = { ...c, stage_label: STAGE_LABELS[c.stage] };
  if (p.kind !== "client") return base;
  const { id, content_code, title, stage, stage_label, client_name, platforms, format, due_at, version } = base as Record<string, unknown>;
  return { id, content_code, title, stage, stage_label, client_name, platforms, format, due_at, version };
}

export async function contentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/content", async (req, reply) => {
    const p = req.principal;
    const scope = requirePermission(p, "content.create");
    const input = parse(CreateContentInput, req.body);
    if (scope !== "org" && input.branchId !== p.branchId) throw forbidden("You can only create content for your own branch");
    const item = await withTx(app.db, async (tx) => {
      const c = await allocateAndInsert(tx, p, input);
      await audit(tx, { orgId: p.orgId, actorUserId: p.userId, action: "content.create", entityType: "content", entityId: c.content_code, after: c, ...reqMeta(req) });
      return c;
    });
    return reply.status(201).send(present(p, item));
  });

  app.get("/content", async (req) => {
    const p = req.principal;
    const scope = requirePermission(p, "content.read");
    const q = parse(
      Pagination.extend({
        stage: z.enum(CONTENT_STAGES).optional(),
        clientId: z.string().uuid().optional(),
        channelId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        mine: z.coerce.boolean().optional(),
        overdue: z.coerce.boolean().optional(),
        q: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const params: unknown[] = [p.orgId];
    const where = ["c.organisation_id = $1", contentScopeSql(p, scope, params)];
    if (q.stage) where.push(`c.stage = $${params.push(q.stage)}`);
    if (q.clientId) where.push(`c.client_id = $${params.push(q.clientId)}`);
    if (q.channelId) where.push(`c.channel_id = $${params.push(q.channelId)}`);
    if (q.branchId) where.push(`c.branch_id = $${params.push(q.branchId)}`);
    if (q.mine) where.push(`c.stage_owner_id = $${params.push(p.userId)}`);
    if (q.overdue) where.push(`c.stage NOT IN ('archived','cancelled','published','analytics_24h','analytics_7d','analytics_30d') AND COALESCE(c.stage_due_at, c.due_at) < now()`);
    if (q.q) {
      const code = normaliseContentIdQuery(q.q);
      where.push(`(c.content_code = $${params.push(code)} OR c.content_code LIKE $${params.push(`${code}%`)} OR c.title ILIKE $${params.push(`%${q.q}%`)})`);
    }
    if (q.cursor) where.push(`c.created_at < $${params.push(q.cursor)}`);
    params.push(q.limit + 1);
    const r = await app.db.query<ContentRow>(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT $${params.length}`, params);
    const items = r.rows.slice(0, q.limit);
    const last = items[items.length - 1] as { created_at?: Date } | undefined;
    return { items: items.map((c) => present(p, c)), nextCursor: r.rows.length > q.limit && last?.created_at ? last.created_at.toISOString() : null };
  });

  app.get("/content/:idOrCode", async (req) => {
    const { idOrCode } = parse(z.object({ idOrCode: z.string().max(60) }), req.params);
    const c = await loadVisible(app, req.principal, idOrCode);
    return {
      ...present(req.principal, c),
      actions: availableTransitions(req.principal, c).map((t) => ({ to: t.to, label: t.action, requiresNote: Boolean(t.requiresNote), ownerRole: t.ownerRole ?? null })),
    };
  });

  app.get("/content/:idOrCode/history", async (req) => {
    const { idOrCode } = parse(z.object({ idOrCode: z.string().max(60) }), req.params);
    const c = await loadVisible(app, req.principal, idOrCode);
    if (req.principal.kind === "client") throw forbidden();
    const r = await app.db.query(
      `SELECT e.id, e.kind, e.from_stage, e.to_stage, e.note, e.created_at, a.display_name AS actor_name, s.display_name AS assignee_name
         FROM content_events e JOIN users a ON a.id = e.actor_id LEFT JOIN users s ON s.id = e.assignee_id
        WHERE e.content_id = $1 ORDER BY e.id`,
      [c.id],
    );
    return { items: r.rows };
  });

  app.post("/content/:id/transition", async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(TransitionInput, req.body);
    const p = req.principal;
    const updated = await withTx(app.db, (tx) => transition(tx, p, id, input, reqMeta(req)));
    return present(p, updated);
  });

  app.get("/content/:id/comments", async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await loadVisible(app, req.principal, id);
    const r = await app.db.query(
      `SELECT m.id, m.body, m.visibility, m.created_at, u.display_name AS author_name
         FROM content_comments m JOIN users u ON u.id = m.author_id
        WHERE m.content_id = $1 AND m.deleted_at IS NULL ${req.principal.kind === "client" ? "AND m.visibility = 'client'" : ""}
        ORDER BY m.created_at`,
      [c.id],
    );
    return { items: r.rows };
  });

  app.post("/content/:id/comments", async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(CommentInput.extend({ visibility: z.enum(["internal", "client"]).default("internal") }), req.body);
    const p = req.principal;
    const c = await loadVisible(app, p, id);
    const visibility = p.kind === "client" ? "client" : body.visibility;
    const r = await withTx(app.db, async (tx) => {
      const m = (await tx.query("INSERT INTO content_comments (content_id, author_id, body, visibility) VALUES ($1,$2,$3,$4) RETURNING *", [c.id, p.userId, body.body, visibility])).rows[0];
      await tx.query("INSERT INTO content_events (content_id, kind, note, actor_id) VALUES ($1,'comment',$2,$3)", [c.id, body.body.slice(0, 500), p.userId]);
      return m;
    });
    return reply.status(201).send(r);
  });

  /** Per-stage counts for the production pipeline board. */
  app.get("/content-pipeline", async (req) => {
    const p = req.principal;
    const scope = scopeOf(p, "content.read");
    if (!scope) throw forbidden();
    const params: unknown[] = [p.orgId];
    const where = contentScopeSql(p, scope, params);
    const r = await app.db.query(
      `SELECT c.stage, count(*)::int AS count,
              count(*) FILTER (WHERE COALESCE(c.stage_due_at, c.due_at) < now())::int AS overdue
         FROM content_items c WHERE c.organisation_id = $1 AND ${where} GROUP BY c.stage`,
      params,
    );
    return { items: r.rows };
  });
}

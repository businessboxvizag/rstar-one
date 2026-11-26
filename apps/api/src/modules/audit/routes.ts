import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Pagination } from "@rstar/shared";
import { parse } from "../../app.js";
import { requirePermission } from "../../auth/principal.js";

export async function auditRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/audit", async (req) => {
    requirePermission(req.principal, "audit.read", "org");
    const q = parse(
      Pagination.extend({
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(80).optional(),
        actorUserId: z.string().uuid().optional(),
        action: z.string().max(80).optional(),
      }),
      req.query,
    );
    const params: unknown[] = [req.principal.orgId];
    const where = ["a.organisation_id = $1"];
    if (q.entityType) where.push(`a.entity_type = $${params.push(q.entityType)}`);
    if (q.entityId) where.push(`a.entity_id = $${params.push(q.entityId)}`);
    if (q.actorUserId) where.push(`a.actor_user_id = $${params.push(q.actorUserId)}`);
    if (q.action) where.push(`a.action LIKE $${params.push(`${q.action}%`)}`);
    if (q.cursor) where.push(`a.id < $${params.push(Number(q.cursor))}`);
    params.push(q.limit + 1);
    const r = await app.db.query(
      `SELECT a.*, u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    const items = r.rows.slice(0, q.limit);
    return { items, nextCursor: r.rows.length > q.limit ? String(items[items.length - 1]?.id) : null };
  });
}

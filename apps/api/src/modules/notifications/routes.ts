import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../../app.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/notifications", async (req) => {
    const q = parse(z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    const r = await app.db.query(
      `SELECT id, kind, title, body, entity_type, entity_id, read_at, created_at FROM notifications
        WHERE user_id = $1 ${q.unread ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT $2`,
      [req.principal.userId, q.limit],
    );
    const unread = await app.db.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [req.principal.userId]);
    return { items: r.rows, unread: unread.rows[0].n };
  });

  app.post("/notifications/:id/read", async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await app.db.query("UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL", [id, req.principal.userId]);
    return { ok: true };
  });

  app.post("/notifications/read-all", async (req) => {
    await app.db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [req.principal.userId]);
    return { ok: true };
  });
}

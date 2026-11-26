import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PERMISSIONS, RoleInput, SCOPES, isPermissionKey } from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requirePermission } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { withTx } from "../../db.js";
import { badRequest, forbidden, notFound } from "../../errors.js";

export async function roleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/permissions", async (req) => {
    requirePermission(req.principal, "users.manage", "org");
    return { scopes: SCOPES, items: PERMISSIONS };
  });

  app.get("/roles", async (req) => {
    requirePermission(req.principal, "users.manage", "org");
    const r = await app.db.query(
      `SELECT r.id, r.key, r.name, r.description, r.audience, r.mfa_required, r.is_system, r.active,
              COALESCE(jsonb_object_agg(rp.permission_key, rp.scope) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS grants
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organisation_id = $1 GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
      [req.principal.orgId],
    );
    return { items: r.rows };
  });

  app.post("/roles", async (req, reply) => {
    requirePermission(req.principal, "roles.manage", "org");
    const b = parse(RoleInput, req.body);
    const role = await withTx(app.db, async (tx) => {
      const r = (
        await tx.query(
          `INSERT INTO roles (organisation_id, key, name, description, mfa_required) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [req.principal.orgId, b.key, b.name, b.description, b.mfaRequired],
        )
      ).rows[0];
      await writeGrants(tx, r.id, b.grants);
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "role.create", entityType: "role", entityId: r.id, after: { ...r, grants: b.grants }, ...reqMeta(req) });
      return r;
    });
    return reply.status(201).send(role);
  });

  app.put("/roles/:id/permissions", async (req) => {
    requirePermission(req.principal, "roles.manage", "org");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { grants } = parse(RoleInput.pick({ grants: true }), req.body);
    return withTx(app.db, async (tx) => {
      const role = (await tx.query("SELECT * FROM roles WHERE id = $1 AND organisation_id = $2 FOR UPDATE", [id, req.principal.orgId])).rows[0];
      if (!role) throw notFound("Role");
      if (role.key === "super_admin") throw forbidden("The Super Admin role cannot be reduced");
      if (role.audience === "client" && Object.keys(grants).some((k) => !["review.client", "content.read", "crm.read", "finance.read"].includes(k))) {
        throw badRequest("Client roles may only hold client-portal permissions");
      }
      const before = (await tx.query("SELECT permission_key, scope FROM role_permissions WHERE role_id = $1", [id])).rows;
      await tx.query("DELETE FROM role_permissions WHERE role_id = $1", [id]);
      await writeGrants(tx, id, grants);
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "role.permissions_update", entityType: "role", entityId: id, before, after: grants, ...reqMeta(req) });
      return { id, grants };
    });
  });
}

async function writeGrants(tx: { query: FastifyInstance["db"]["query"] }, roleId: string, grants: Record<string, string>) {
  for (const [k, s] of Object.entries(grants)) {
    if (!isPermissionKey(k)) throw badRequest(`Unknown permission ${k}`);
    await tx.query("INSERT INTO role_permissions (role_id, permission_key, scope) VALUES ($1,$2,$3)", [roleId, k, s]);
  }
}

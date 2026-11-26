import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BranchInput, DepartmentInput, DesignationInput, SequenceInput } from "@rstar/shared";
import { parse, reqMeta } from "../../app.js";
import { requirePermission } from "../../auth/principal.js";
import { audit } from "../../lib/audit.js";
import { withTx } from "../../db.js";
import { badRequest, notFound } from "../../errors.js";

const IdParam = z.object({ id: z.string().uuid() });

/** Organisation structure: org profile, branches, departments, designations, channels, clients, Content ID sequences. */
export async function orgRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/organisation", async (req) => {
    const r = await app.db.query(
      "SELECT id, legal_name, product_name, partner_label, timezone, currency, settings FROM organisations WHERE id = $1",
      [req.principal.orgId],
    );
    return r.rows[0];
  });

  app.patch("/organisation", async (req) => {
    requirePermission(req.principal, "org.settings.manage", "org");
    const body = parse(
      z.object({ productName: z.string().trim().min(2).max(60).optional(), legalName: z.string().trim().min(2).max(200).optional(), partnerLabel: z.string().trim().max(120).optional() }),
      req.body,
    );
    return withTx(app.db, async (tx) => {
      const before = (await tx.query("SELECT product_name, legal_name, partner_label FROM organisations WHERE id = $1 FOR UPDATE", [req.principal.orgId])).rows[0];
      const after = (
        await tx.query(
          `UPDATE organisations SET product_name = COALESCE($2, product_name), legal_name = COALESCE($3, legal_name),
              partner_label = COALESCE($4, partner_label) WHERE id = $1 RETURNING product_name, legal_name, partner_label`,
          [req.principal.orgId, body.productName ?? null, body.legalName ?? null, body.partnerLabel ?? null],
        )
      ).rows[0];
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "organisation.update", entityType: "organisation", entityId: req.principal.orgId, before, after, ...reqMeta(req) });
      return after;
    });
  });

  // Generic CRUD for simple structure tables. Reading is open to all staff (needed for forms).
  const structure = [
    { path: "branches", table: "branches", input: BranchInput, cols: ["code", "name", "city", "timezone", "active"] },
    { path: "departments", table: "departments", input: DepartmentInput, cols: ["code", "name", "active"] },
    { path: "designations", table: "designations", input: DesignationInput, cols: ["name", "department_id", "active"] },
  ] as const;

  for (const s of structure) {
    const toRow = (b: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(b).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]),
      ) as Record<string, unknown>;

    app.get(`/${s.path}`, async (req) => {
      const r = await app.db.query(`SELECT * FROM ${s.table} WHERE organisation_id = $1 ORDER BY name`, [req.principal.orgId]);
      return { items: r.rows };
    });

    app.post(`/${s.path}`, async (req, reply) => {
      requirePermission(req.principal, "org.structure.manage", "org");
      const row = toRow(parse(s.input, req.body));
      const cols = s.cols.filter((c) => row[c] !== undefined);
      const created = await withTx(app.db, async (tx) => {
        const r = await tx.query(
          `INSERT INTO ${s.table} (organisation_id, ${cols.join(",")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(",")}) RETURNING *`,
          [req.principal.orgId, ...cols.map((c) => row[c])],
        );
        await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: `${s.path}.create`, entityType: s.table, entityId: r.rows[0].id, after: r.rows[0], ...reqMeta(req) });
        return r.rows[0];
      });
      return reply.status(201).send(created);
    });

    app.patch(`/${s.path}/:id`, async (req) => {
      requirePermission(req.principal, "org.structure.manage", "org");
      const { id } = parse(IdParam, req.params);
      const row = toRow(parse((s.input as z.AnyZodObject).partial(), req.body));
      const cols = s.cols.filter((c) => row[c] !== undefined);
      if (!cols.length) throw badRequest("Nothing to update");
      return withTx(app.db, async (tx) => {
        const before = (await tx.query(`SELECT * FROM ${s.table} WHERE id = $1 AND organisation_id = $2 FOR UPDATE`, [id, req.principal.orgId])).rows[0];
        if (!before) throw notFound();
        const r = await tx.query(
          `UPDATE ${s.table} SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} WHERE id = $1 AND organisation_id = $2 RETURNING *`,
          [id, req.principal.orgId, ...cols.map((c) => row[c])],
        );
        await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: `${s.path}.update`, entityType: s.table, entityId: id, before, after: r.rows[0], ...reqMeta(req) });
        return r.rows[0];
      });
    });
  }

  // ── Channels & clients (lightweight now; full CRM in its milestone) ──
  app.get("/channels", async (req) => {
    const r = await app.db.query(
      `SELECT c.*, s.id AS sequence_id, s.prefix, s.segment_mode, s.padding
         FROM channels c LEFT JOIN content_sequences s ON s.channel_id = c.id
        WHERE c.organisation_id = $1 ORDER BY c.name`,
      [req.principal.orgId],
    );
    return { items: r.rows };
  });

  app.get("/clients", async (req) => {
    const p = req.principal;
    // Client portal users only ever see their own client record.
    const r =
      p.kind === "client"
        ? await app.db.query("SELECT id, name FROM clients WHERE id = $1", [p.clientId])
        : await app.db.query(
            `SELECT c.id, c.name, c.status, c.industry, c.is_demo, s.id AS sequence_id, s.prefix, s.segment_mode, s.padding
               FROM clients c LEFT JOIN content_sequences s ON s.client_id = c.id
              WHERE c.organisation_id = $1 AND c.archived_at IS NULL ORDER BY c.name`,
            [p.orgId],
          );
    return { items: r.rows };
  });

  const NewOwner = z.object({ name: z.string().trim().min(2).max(160), industry: z.string().max(80).optional() }).merge(SequenceInput);

  app.post("/clients", async (req, reply) => {
    requirePermission(req.principal, "crm.manage", "org");
    requirePermission(req.principal, "channels.manage", "org");
    const b = parse(NewOwner, req.body);
    const out = await withTx(app.db, async (tx) => {
      await assertPrefixFree(tx, req.principal.orgId, b.prefix);
      const c = (await tx.query("INSERT INTO clients (organisation_id, name, industry, created_by) VALUES ($1,$2,$3,$4) RETURNING *", [req.principal.orgId, b.name, b.industry ?? null, req.principal.userId])).rows[0];
      const s = (await tx.query("INSERT INTO content_sequences (organisation_id, client_id, prefix, segment_mode, padding) VALUES ($1,$2,$3,$4,$5) RETURNING *", [req.principal.orgId, c.id, b.prefix, b.segmentMode, b.padding])).rows[0];
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "client.create", entityType: "client", entityId: c.id, after: { client: c, sequence: s }, ...reqMeta(req) });
      return { ...c, sequence_id: s.id, prefix: s.prefix };
    });
    return reply.status(201).send(out);
  });

  app.post("/channels", async (req, reply) => {
    requirePermission(req.principal, "channels.manage", "org");
    const b = parse(NewOwner, req.body);
    const out = await withTx(app.db, async (tx) => {
      await assertPrefixFree(tx, req.principal.orgId, b.prefix);
      const c = (await tx.query("INSERT INTO channels (organisation_id, name) VALUES ($1,$2) RETURNING *", [req.principal.orgId, b.name])).rows[0];
      const s = (await tx.query("INSERT INTO content_sequences (organisation_id, channel_id, prefix, segment_mode, padding) VALUES ($1,$2,$3,$4,$5) RETURNING *", [req.principal.orgId, c.id, b.prefix, b.segmentMode, b.padding])).rows[0];
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "channel.create", entityType: "channel", entityId: c.id, after: { channel: c, sequence: s }, ...reqMeta(req) });
      return { ...c, sequence_id: s.id, prefix: s.prefix };
    });
    return reply.status(201).send(out);
  });

  /** Change a sequence's prefix/format. The old prefix is retired permanently. Issued IDs never change. */
  app.patch("/content-sequences/:id", async (req) => {
    requirePermission(req.principal, "channels.manage", "org");
    const { id } = parse(IdParam, req.params);
    const b = parse(SequenceInput.partial(), req.body);
    return withTx(app.db, async (tx) => {
      const before = (await tx.query("SELECT * FROM content_sequences WHERE id = $1 AND organisation_id = $2 FOR UPDATE", [id, req.principal.orgId])).rows[0];
      if (!before) throw notFound("Sequence");
      if (b.prefix && b.prefix !== before.prefix) {
        await assertPrefixFree(tx, req.principal.orgId, b.prefix);
        await tx.query("INSERT INTO content_prefix_history (organisation_id, prefix, sequence_id) VALUES ($1,$2,$3)", [req.principal.orgId, before.prefix, id]);
      }
      const after = (
        await tx.query(
          `UPDATE content_sequences SET prefix = COALESCE($2, prefix), segment_mode = COALESCE($3, segment_mode), padding = COALESCE($4, padding), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, b.prefix ?? null, b.segmentMode ?? null, b.padding ?? null],
        )
      ).rows[0];
      await audit(tx, { orgId: req.principal.orgId, actorUserId: req.principal.userId, action: "content_sequence.update", entityType: "content_sequence", entityId: id, before, after, ...reqMeta(req) });
      return after;
    });
  });
}

async function assertPrefixFree(tx: { query: FastifyInstance["db"]["query"] }, orgId: string, prefix: string) {
  const r = await tx.query(
    `SELECT 1 FROM content_sequences WHERE organisation_id = $1 AND prefix = $2
     UNION ALL SELECT 1 FROM content_prefix_history WHERE organisation_id = $1 AND prefix = $2`,
    [orgId, prefix],
  );
  if (r.rowCount) throw badRequest(`Prefix ${prefix} is already in use or was used before and is retired`);
}

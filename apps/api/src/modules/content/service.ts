import {
  STAGE_LABELS,
  findTransition,
  formatContentId,
  nextStages,
  type ContentStage,
  type CreateContentInput,
  type PermissionKey,
  type Transition,
  type TransitionInput,
} from "@rstar/shared";
import type { Tx, Queryable } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { scopeCovers, scopeOf, type Principal, type ScopedRecord } from "../../auth/principal.js";

export interface ContentRow {
  id: string;
  organisation_id: string;
  content_code: string;
  stage: ContentStage;
  branch_id: string;
  department_id: string | null;
  client_id: string | null;
  channel_id: string | null;
  stage_owner_id: string | null;
  producer_id: string | null;
  script_writer_id: string | null;
  camera_operator_id: string | null;
  editor_id: string | null;
  publisher_id: string | null;
  created_by: string;
  requires_client_approval: boolean;
  version: number;
  [k: string]: unknown;
}

export function contentScopeRecord(c: ContentRow): ScopedRecord {
  return {
    branchId: c.branch_id,
    departmentId: c.department_id,
    clientId: c.client_id,
    userIds: [c.stage_owner_id, c.producer_id, c.script_writer_id, c.camera_operator_id, c.editor_id, c.publisher_id, c.created_by].filter(
      (x): x is string => Boolean(x),
    ),
  };
}

export function canOnContent(p: Principal, key: PermissionKey, c: ContentRow): boolean {
  const s = scopeOf(p, key);
  return Boolean(s && scopeCovers(p, s, contentScopeRecord(c)));
}

/**
 * Allocates the next Content ID for a sequence and inserts the item — in the caller's transaction.
 *
 * Concurrency: the counter row is created or incremented by one atomic
 * INSERT ... ON CONFLICT DO UPDATE; Postgres row-locks it until commit, so
 * concurrent creators are serialised and each receives a distinct number.
 * If the surrounding transaction rolls back, the increment rolls back too, so
 * an ID is only "used" once an item exists — and items can never be deleted.
 */
export async function allocateAndInsert(tx: Tx, p: Principal, input: CreateContentInput) {
  const seq = (
    await tx.query(
      `SELECT s.id, s.prefix, s.segment_mode, s.padding, s.active
         FROM content_sequences s
        WHERE s.organisation_id = $1 AND ${input.clientId ? "s.client_id = $2" : "s.channel_id = $2"}`,
      [p.orgId, input.clientId ?? input.channelId],
    )
  ).rows[0];
  if (!seq) throw badRequest("No Content ID sequence is configured for this client/channel");
  if (!seq.active) throw badRequest("This Content ID sequence is inactive");

  let segment = "";
  if (seq.segment_mode === "year") segment = String(new Date().getFullYear());
  if (seq.segment_mode === "campaign") {
    if (!input.campaign) throw badRequest("This client/channel uses campaign segments: campaign is required");
    segment = input.campaign;
  }

  const n = (
    await tx.query<{ last_value: number }>(
      `INSERT INTO content_sequence_counters (sequence_id, segment, last_value) VALUES ($1, $2, 1)
       ON CONFLICT (sequence_id, segment) DO UPDATE SET last_value = content_sequence_counters.last_value + 1
       RETURNING last_value`,
      [seq.id, segment],
    )
  ).rows[0]!.last_value;

  const code = formatContentId({ prefix: seq.prefix, segment: segment || null, value: n, padding: seq.padding });

  const item = (
    await tx.query<ContentRow>(
      `INSERT INTO content_items (organisation_id, content_code, sequence_id, sequence_segment, sequence_value, title, brief,
          client_id, channel_id, branch_id, department_id, format, platforms, language, priority, due_at,
          requires_client_approval, producer_id, stage_owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$18)
       RETURNING *`,
      [
        p.orgId, code, seq.id, segment, n, input.title, input.brief, input.clientId ?? null, input.channelId ?? null,
        input.branchId, input.departmentId ?? null, input.format, input.platforms, input.language, input.priority,
        input.dueAt ?? null, input.requiresClientApproval, p.userId,
      ],
    )
  ).rows[0]!;

  await tx.query(`INSERT INTO content_events (content_id, kind, to_stage, actor_id) VALUES ($1,'created','idea',$2)`, [item.id, p.userId]);
  return item;
}

const OWNER_FIELD: Record<NonNullable<Transition["ownerRole"]>, keyof ContentRow> = {
  script_writer: "script_writer_id",
  camera_operator: "camera_operator_id",
  editor: "editor_id",
  publisher: "publisher_id",
  producer: "producer_id",
};

const OWNER_PERMISSION: Record<NonNullable<Transition["ownerRole"]>, PermissionKey> = {
  script_writer: "script.write",
  camera_operator: "footage.upload",
  editor: "edit.work",
  publisher: "publish.manage",
  producer: "content.assign",
};

/** Transitions the principal may perform now on this item (for UI action buttons). */
export function availableTransitions(p: Principal, c: ContentRow): Transition[] {
  return nextStages(c.stage).filter((t) => canOnContent(p, t.permission, c));
}

async function userHasPermission(q: Queryable, userId: string, orgId: string, key: PermissionKey): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_key = $3
      WHERE u.id = $1 AND u.organisation_id = $2 AND u.status = 'active'
     UNION ALL
     SELECT 1 FROM users u JOIN roles r ON r.organisation_id = u.organisation_id AND r.key = 'employee_base'
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = $3
      WHERE u.id = $1 AND u.organisation_id = $2 AND u.status = 'active' AND u.kind = 'staff'
     LIMIT 1`,
    [userId, orgId, key],
  );
  return Boolean(r.rowCount);
}

export async function transition(
  tx: Tx,
  p: Principal,
  contentId: string,
  input: TransitionInput,
  meta: { ip: string; userAgent: string | null; requestId: string },
) {
  const c = (await tx.query<ContentRow>("SELECT * FROM content_items WHERE id = $1 AND organisation_id = $2 FOR UPDATE", [contentId, p.orgId])).rows[0];
  if (!c) throw notFound("Content");
  if (!canOnContent(p, "content.read", c)) throw notFound("Content");
  if (c.version !== input.expectedVersion) {
    throw conflict("This item was changed by someone else. Reload and try again.", { currentVersion: c.version, stage: c.stage });
  }

  const candidates = findTransition(c.stage, input.to);
  if (!candidates.length) throw badRequest(`Cannot move from "${STAGE_LABELS[c.stage]}" to "${STAGE_LABELS[input.to]}"`);
  const t = candidates.find((x) => canOnContent(p, x.permission, c));
  if (!t) throw forbidden();
  if (t.requiresNote && !input.note) throw badRequest("A reason is required for this action");

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length + 1}`);
  };

  let newOwner: string | null = null;
  if (t.ownerRole) {
    const field = OWNER_FIELD[t.ownerRole];
    if (input.assigneeUserId) {
      if (!(await userHasPermission(tx, input.assigneeUserId, p.orgId, OWNER_PERMISSION[t.ownerRole]))) {
        throw badRequest(`The selected person cannot take this work (needs ${OWNER_PERMISSION[t.ownerRole]})`);
      }
      set(String(field), input.assigneeUserId);
      newOwner = input.assigneeUserId;
    } else {
      newOwner = (c[field] as string | null) ?? (t.ownerRole === "producer" ? c.created_by : null);
      if (!newOwner) throw badRequest("Choose who this is assigned to");
    }
  } else {
    newOwner = c.stage_owner_id;
  }
  set("stage", t.to);
  set("stage_owner_id", newOwner);
  set("stage_entered_at", new Date());
  set("stage_due_at", input.stageDueAt ?? null);
  set("updated_by", p.userId);
  if (t.to === "revisions_requested") sets.push("revision_count = revision_count + 1");
  if (t.to === "cancelled") set("cancel_reason", input.note);
  sets.push("version = version + 1");

  const updated = (
    await tx.query<ContentRow>(`UPDATE content_items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, [contentId, ...vals])
  ).rows[0]!;

  await tx.query(
    `INSERT INTO content_events (content_id, kind, from_stage, to_stage, note, assignee_id, actor_id) VALUES ($1,'transition',$2,$3,$4,$5,$6)`,
    [contentId, c.stage, t.to, input.note ?? null, newOwner !== c.stage_owner_id ? newOwner : null, p.userId],
  );
  if (newOwner && newOwner !== p.userId) {
    await tx.query(
      `INSERT INTO notifications (organisation_id, user_id, kind, title, body, entity_type, entity_id) VALUES ($1,$2,'content.stage',$3,$4,'content',$5)`,
      [p.orgId, newOwner, `${c.content_code}: ${STAGE_LABELS[t.to]}`, input.note ?? `${p.displayName} moved this to "${STAGE_LABELS[t.to]}"`, contentId],
    );
  }
  await audit(tx, {
    orgId: p.orgId,
    actorUserId: p.userId,
    action: "content.transition",
    entityType: "content",
    entityId: c.content_code,
    before: { stage: c.stage, owner: c.stage_owner_id, version: c.version },
    after: { stage: t.to, owner: newOwner, version: updated.version, note: input.note ?? null },
    ...meta,
  });
  return updated;
}

import type { PermissionKey } from "./permissions.js";

/**
 * Media production lifecycle. Every content item carries exactly one stage.
 * Transitions are enforced by the API (see apps/api/src/modules/content).
 *
 * The person's spec lists 27 stages. One explicit stage, `first_cut_approved`,
 * is added so a review approval is a recorded state rather than an implicit
 * jump; `cancelled` is terminal and keeps the Content ID reserved forever.
 */
export const CONTENT_STAGES = [
  "idea",
  "script_assigned",
  "script_submitted",
  "script_in_review",
  "script_approved",
  "shoot_scheduled",
  "shoot_assigned",
  "shoot_in_progress",
  "shoot_completed",
  "footage_upload_initiated",
  "footage_received",
  "footage_verification",
  "footage_accepted",
  "editor_assigned",
  "editing_in_progress",
  "first_cut_submitted",
  "internal_review",
  "client_review",
  "revisions_requested",
  "first_cut_approved",
  "final_cut_submitted",
  "final_approved",
  "posting_scheduled",
  "published",
  "analytics_24h",
  "analytics_7d",
  "analytics_30d",
  "archived",
  "cancelled",
] as const;

export type ContentStage = (typeof CONTENT_STAGES)[number];

export const STAGE_LABELS: Record<ContentStage, string> = {
  idea: "Idea created",
  script_assigned: "Script writing assigned",
  script_submitted: "Script draft submitted",
  script_in_review: "Script review",
  script_approved: "Script approved",
  shoot_scheduled: "Shoot scheduled",
  shoot_assigned: "Shoot assigned",
  shoot_in_progress: "Shoot in progress",
  shoot_completed: "Shoot completed",
  footage_upload_initiated: "Footage upload initiated",
  footage_received: "Footage received",
  footage_verification: "File verification",
  footage_accepted: "Footage accepted",
  editor_assigned: "Editor assigned",
  editing_in_progress: "Editing in progress",
  first_cut_submitted: "First cut submitted",
  internal_review: "Internal review",
  client_review: "Client / management review",
  revisions_requested: "Revisions requested",
  first_cut_approved: "First cut approved",
  final_cut_submitted: "Final cut submitted",
  final_approved: "Final approval",
  posting_scheduled: "Posting scheduled",
  published: "Published",
  analytics_24h: "24-hour analytics",
  analytics_7d: "7-day analytics",
  analytics_30d: "30-day analytics",
  archived: "Archived",
  cancelled: "Cancelled",
};

export type StagePhase = "planning" | "script" | "shoot" | "footage" | "edit" | "review" | "publish" | "analytics" | "closed";

export const STAGE_PHASE: Record<ContentStage, StagePhase> = {
  idea: "planning",
  script_assigned: "script",
  script_submitted: "script",
  script_in_review: "script",
  script_approved: "script",
  shoot_scheduled: "shoot",
  shoot_assigned: "shoot",
  shoot_in_progress: "shoot",
  shoot_completed: "shoot",
  footage_upload_initiated: "footage",
  footage_received: "footage",
  footage_verification: "footage",
  footage_accepted: "footage",
  editor_assigned: "edit",
  editing_in_progress: "edit",
  first_cut_submitted: "edit",
  internal_review: "review",
  client_review: "review",
  revisions_requested: "edit",
  first_cut_approved: "review",
  final_cut_submitted: "review",
  final_approved: "publish",
  posting_scheduled: "publish",
  published: "publish",
  analytics_24h: "analytics",
  analytics_7d: "analytics",
  analytics_30d: "analytics",
  archived: "closed",
  cancelled: "closed",
};

export interface Transition {
  from: ContentStage;
  to: ContentStage;
  /** Permission the actor needs (at a scope covering the content item). */
  permission: PermissionKey;
  /** Rejections / revision requests must carry a reason. */
  requiresNote?: boolean;
  /** Short verb shown on the action button. */
  action: string;
  /** Who becomes the stage owner after the transition. */
  ownerRole?: "script_writer" | "camera_operator" | "editor" | "publisher" | "producer";
}

const t = (
  from: ContentStage,
  to: ContentStage,
  permission: PermissionKey,
  action: string,
  extra: Partial<Transition> = {},
): Transition => ({ from, to, permission, action, ...extra });

export const TRANSITIONS: readonly Transition[] = [
  // Planning → script, or straight to shoot / footage when no script is needed (e.g. news).
  t("idea", "script_assigned", "content.assign", "Assign script", { ownerRole: "script_writer" }),
  t("idea", "shoot_scheduled", "shoot.schedule", "Schedule shoot (no script)", { ownerRole: "producer" }),
  t("idea", "footage_upload_initiated", "footage.upload", "Start footage upload (no shoot)", { ownerRole: "camera_operator" }),
  // Script
  t("script_assigned", "script_submitted", "script.write", "Submit script draft", { ownerRole: "producer" }),
  t("script_submitted", "script_in_review", "script.review", "Start script review"),
  t("script_in_review", "script_approved", "script.approve", "Approve script", { ownerRole: "producer" }),
  t("script_in_review", "script_assigned", "script.approve", "Reject script", { requiresNote: true, ownerRole: "script_writer" }),
  t("script_approved", "shoot_scheduled", "shoot.schedule", "Schedule shoot"),
  t("script_approved", "footage_upload_initiated", "footage.upload", "Start footage upload (no shoot)", { ownerRole: "camera_operator" }),
  // Shoot
  t("shoot_scheduled", "shoot_assigned", "shoot.schedule", "Assign crew", { ownerRole: "camera_operator" }),
  t("shoot_assigned", "shoot_in_progress", "shoot.execute", "Start shoot"),
  t("shoot_in_progress", "shoot_completed", "shoot.execute", "Complete shoot"),
  t("shoot_completed", "footage_upload_initiated", "footage.upload", "Start footage upload"),
  // Footage
  t("footage_upload_initiated", "footage_received", "footage.upload", "Mark footage received", { ownerRole: "producer" }),
  t("footage_received", "footage_verification", "footage.verify", "Start verification"),
  t("footage_verification", "footage_accepted", "footage.verify", "Accept footage"),
  t("footage_verification", "footage_upload_initiated", "footage.verify", "Reject footage", { requiresNote: true, ownerRole: "camera_operator" }),
  // Editing
  t("footage_accepted", "editor_assigned", "edit.assign", "Assign editor", { ownerRole: "editor" }),
  t("editor_assigned", "editing_in_progress", "edit.work", "Start editing"),
  t("editing_in_progress", "first_cut_submitted", "edit.work", "Submit first cut", { ownerRole: "producer" }),
  t("first_cut_submitted", "internal_review", "review.internal", "Start internal review"),
  t("internal_review", "client_review", "review.internal", "Send to client / management review"),
  t("internal_review", "first_cut_approved", "review.internal", "Approve first cut", { ownerRole: "editor" }),
  t("internal_review", "revisions_requested", "review.internal", "Request revisions", { requiresNote: true, ownerRole: "editor" }),
  t("client_review", "first_cut_approved", "review.client", "Approve (client)", { ownerRole: "editor" }),
  t("client_review", "revisions_requested", "review.client", "Request changes (client)", { requiresNote: true, ownerRole: "editor" }),
  t("client_review", "first_cut_approved", "content.final_approve", "Approve (management)", { ownerRole: "editor" }),
  t("client_review", "revisions_requested", "content.final_approve", "Request changes (management)", { requiresNote: true, ownerRole: "editor" }),
  t("revisions_requested", "editing_in_progress", "edit.work", "Resume editing"),
  t("first_cut_approved", "final_cut_submitted", "edit.work", "Submit final cut", { ownerRole: "producer" }),
  t("final_cut_submitted", "final_approved", "content.final_approve", "Final approval", { ownerRole: "publisher" }),
  t("final_cut_submitted", "revisions_requested", "content.final_approve", "Request revisions", { requiresNote: true, ownerRole: "editor" }),
  // Publishing & analytics
  t("final_approved", "posting_scheduled", "publish.manage", "Schedule posting"),
  t("posting_scheduled", "published", "publish.manage", "Confirm published"),
  t("published", "analytics_24h", "analytics.manage", "Record 24h analytics"),
  t("analytics_24h", "analytics_7d", "analytics.manage", "Record 7-day analytics"),
  t("analytics_7d", "analytics_30d", "analytics.manage", "Record 30-day analytics"),
  t("analytics_30d", "archived", "content.assign", "Archive"),
];

/** Stages from which an item may be cancelled (anything before publishing). */
export const CANCELLABLE: ReadonlySet<ContentStage> = new Set(
  CONTENT_STAGES.slice(0, CONTENT_STAGES.indexOf("published")),
);

export function findTransition(from: ContentStage, to: ContentStage): Transition[] {
  if (to === "cancelled" && CANCELLABLE.has(from)) {
    return [t(from, "cancelled", "content.cancel", "Cancel", { requiresNote: true })];
  }
  return TRANSITIONS.filter((x) => x.from === from && x.to === to);
}

export function nextStages(from: ContentStage): Transition[] {
  const list = TRANSITIONS.filter((x) => x.from === from);
  if (CANCELLABLE.has(from)) list.push(t(from, "cancelled", "content.cancel", "Cancel", { requiresNote: true }));
  return list;
}

export const TERMINAL_STAGES: ReadonlySet<ContentStage> = new Set(["archived", "cancelled"]);

/** Permission a person must hold to be assigned as each stage owner. */
export const OWNER_ROLE_PERMISSION: Record<NonNullable<Transition["ownerRole"]>, PermissionKey> = {
  script_writer: "script.write",
  camera_operator: "footage.upload",
  editor: "edit.work",
  publisher: "publish.manage",
  producer: "content.assign",
};

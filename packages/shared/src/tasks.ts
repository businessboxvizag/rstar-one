import { z } from "zod";

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

/** Who is changing a task's status: the person doing it, or the person who assigned/manages it. */
export type TaskActor = "assignee" | "manager";

/**
 * Whether `actor` may move a task from `from` to `to`.
 * The assignee works the task (start, block, finish, reopen their own done task).
 * The creator/manager can do all of that and also cancel, restore and reset to "To do".
 */
export function canSetTaskStatus(from: TaskStatus, to: TaskStatus, actor: TaskActor): boolean {
  if (from === to) return false;
  // A finished task can only be reopened (or, by a manager, cancelled).
  if (from === "done" && to !== "in_progress" && !(actor === "manager" && to === "cancelled")) return false;
  if (actor === "manager") return true;
  if (from === "cancelled") return false;
  return to === "in_progress" || to === "blocked" || to === "done";
}

/** Status changes that must carry a note explaining why. */
export const taskStatusNeedsNote = (to: TaskStatus) => to === "blocked" || to === "cancelled";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const title = z.string().trim().min(3, "At least 3 characters").max(200);
const description = z.string().trim().max(5000);

export const TaskCreateInput = z.object({
  title,
  description: description.optional().default(""),
  /** Defaults to the caller's own employee record. */
  assigneeEmployeeId: z.string().uuid().optional(),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  dueDate: isoDate.nullish(),
  contentCode: z.string().trim().max(40).nullish(),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInput>;

export const TaskUpdateInput = z
  .object({
    title: title.optional(),
    description: description.optional(),
    assigneeEmployeeId: z.string().uuid().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueDate: isoDate.nullable().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion"), "Nothing to change");
export type TaskUpdateInput = z.infer<typeof TaskUpdateInput>;

export const TaskStatusInput = z
  .object({ status: z.enum(TASK_STATUSES), note: z.string().trim().max(1000).optional(), expectedVersion: z.number().int().positive() })
  .refine((v) => !taskStatusNeedsNote(v.status) || (v.note && v.note.length >= 3), { message: "Please add a short note", path: ["note"] });
export type TaskStatusInput = z.infer<typeof TaskStatusInput>;

export const TaskCommentInput = z.object({ body: z.string().trim().min(1).max(4000) });

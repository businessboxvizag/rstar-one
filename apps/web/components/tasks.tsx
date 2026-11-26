import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, type TaskPriority, type TaskStatus } from "@rstar/shared";

export interface TaskItem {
  id: string;
  number: number;
  title: string;
  description: string;
  assignee: { employeeId: string; name: string; code: string; isMe: boolean };
  createdBy: { name: string; isMe: boolean };
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  overdue: boolean;
  content: { code: string; title: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  version: number;
  can?: { work: boolean; manage: boolean; comment: boolean };
}

export interface Assignee { employeeId: string; name: string; code: string; department: string; isMe: boolean }

const STATUS_STYLE: Record<TaskStatus, string> = {
  open: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-50 text-blue-700",
  blocked: "bg-amber-50 text-amber-800",
  done: "bg-green-50 text-green-700",
  cancelled: "bg-gray-100 text-gray-500 line-through",
};
const PRIORITY_STYLE: Record<TaskPriority, string> = {
  low: "text-ink-faint",
  normal: "text-ink-muted",
  high: "text-amber-700",
  urgent: "text-red-700 font-semibold",
};

export const TaskStatusChip = ({ status }: { status: TaskStatus }) => <span className={`chip ${STATUS_STYLE[status]}`}>{TASK_STATUS_LABEL[status]}</span>;
export const PriorityLabel = ({ priority }: { priority: TaskPriority }) => <span className={`text-xs ${PRIORITY_STYLE[priority]}`}>{TASK_PRIORITY_LABEL[priority]}</span>;

/** "Due 28 Nov", "Due today", "2 days overdue". */
export function dueText(t: Pick<TaskItem, "dueDate" | "overdue" | "status">) {
  if (!t.dueDate) return "No due date";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const days = Math.round((Date.parse(`${t.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const nice = new Date(`${t.dueDate}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  if (t.status === "done" || t.status === "cancelled") return `Due ${nice}`;
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${nice}`;
}

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, canSetTaskStatus, taskStatusNeedsNote, type TaskStatus } from "@rstar/shared";
import { api, ApiError } from "@/lib/api";
import { ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";
import { PriorityLabel, TaskStatusChip, dueText, type Assignee, type TaskItem } from "@/components/tasks";

interface Detail extends TaskItem {
  comments: { id: string; body: string; author: string; isMine: boolean; createdAt: string }[];
  history: { id: number; kind: string; from: string | null; to: string | null; note: string | null; actor: string; at: string }[];
}

const ACTIONS: { to: TaskStatus; label: string; style: string }[] = [
  { to: "in_progress", label: "Start", style: "btn-primary" },
  { to: "done", label: "Mark done", style: "btn-primary" },
  { to: "blocked", label: "Blocked", style: "btn-secondary" },
  { to: "open", label: "Back to To do", style: "btn-ghost" },
  { to: "cancelled", label: "Cancel task", style: "btn-danger" },
];

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const t = useApi<Detail>(`/tasks/${id}`);
  const [editing, setEditing] = useState(false);

  if (t.error) return <ErrorBox error={t.error} onRetry={t.reload} />;
  if (!t.data) return <Loading />;
  const d = t.data;
  return (
    <>
      <div className="mb-2 text-sm"><Link href="/tasks" className="text-ink-muted hover:text-ink">← Tasks</Link></div>
      <PageHeader title={d.title} subtitle={`T-${d.number} · created by ${d.createdBy.isMe ? "you" : d.createdBy.name} on ${formatDate(d.createdAt)}`}
        actions={d.can?.manage && d.status !== "done" && d.status !== "cancelled" && !editing ? <button className="btn-secondary" onClick={() => setEditing(true)}>Edit</button> : null} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {editing ? <EditForm d={d} onDone={() => { setEditing(false); void t.reload(); }} onCancel={() => setEditing(false)} /> : (
            <section className="card p-5">
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div><dt className="label">Status</dt><dd><TaskStatusChip status={d.status} /></dd></div>
                <div><dt className="label">Assigned to</dt><dd>{d.assignee.isMe ? "You" : d.assignee.name}</dd></div>
                <div><dt className="label">Priority</dt><dd><PriorityLabel priority={d.priority} /></dd></div>
                <div><dt className="label">Due</dt><dd className={d.overdue ? "font-medium text-red-700" : ""}>{dueText(d)}</dd></div>
              </dl>
              {d.content && <p className="mt-4 text-sm">Content: <Link className="font-mono font-semibold text-rstar" href={`/production/${d.content.code}`}>{d.content.code}</Link> · {d.content.title}</p>}
              {d.description ? <p className="mt-4 whitespace-pre-wrap text-sm">{d.description}</p> : <p className="mt-4 text-sm text-ink-faint">No details added.</p>}
              <StatusActions d={d} onDone={t.reload} />
            </section>
          )}
          <Comments d={d} onDone={t.reload} />
        </div>
        <section aria-labelledby="hist">
          <h2 id="hist" className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">History</h2>
          <ol className="card divide-y divide-line text-sm">
            {d.history.map((h) => (
              <li key={h.id} className="px-4 py-3">
                <div>{historyText(h)}</div>
                {h.note && <div className="text-ink-muted">“{h.note}”</div>}
                <div className="text-xs text-ink-faint">{h.actor} · {formatDate(h.at, true)}</div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

function historyText(h: Detail["history"][number]) {
  if (h.kind === "created") return `Created and assigned to ${h.to}`;
  if (h.kind === "assigned") return `Reassigned from ${h.from} to ${h.to}`;
  if (h.kind === "status") return `${TASK_STATUS_LABEL[h.from as TaskStatus] ?? h.from} → ${TASK_STATUS_LABEL[h.to as TaskStatus] ?? h.to}`;
  return `Edited ${h.to?.replace("dueDate", "due date")}`;
}

function StatusActions({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [pending, setPending] = useState<TaskStatus | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!d.can?.work) return null;
  const actor = d.can.manage ? "manager" : "assignee";
  const actions = ACTIONS.filter((a) => canSetTaskStatus(d.status, a.to, actor))
    .map((a) => (a.to === "in_progress" && d.status !== "open" ? { ...a, label: d.status === "cancelled" ? "Restore" : "Reopen", style: "btn-secondary" } : a))
    .filter((a) => !(a.to === "open" && d.status === "cancelled"));

  const go = async (to: TaskStatus) => {
    if (taskStatusNeedsNote(to) && pending !== to) { setPending(to); setNote(""); return; }
    setBusy(true);
    setError(null);
    try {
      await api(`/tasks/${d.id}/status`, { method: "POST", body: { status: to, note: note || undefined, expectedVersion: d.version } });
      setPending(null);
      onDone();
    } catch (e) {
      setError(errText(e, "Could not update the task"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => <button key={a.to} className={a.style} disabled={busy} onClick={() => void go(a.to)}>{a.label}</button>)}
      </div>
      {pending && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1"><label className="label" htmlFor="st-note">{pending === "blocked" ? "What is blocking it?" : "Why cancel it?"}</label>
            <input id="st-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></div>
          <button className="btn-primary" disabled={busy || note.trim().length < 3} onClick={() => void go(pending)}>Save</button>
          <button className="btn-ghost" onClick={() => setPending(null)}>Back</button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
    </div>
  );
}

function EditForm({ d, onDone, onCancel }: { d: Detail; onDone: () => void; onCancel: () => void }) {
  const people = useApi<{ items: Assignee[] }>("/tasks/assignees");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      await api(`/tasks/${d.id}`, {
        method: "PATCH",
        body: { title: s("title"), description: s("description"), priority: s("priority"), dueDate: s("dueDate") || null, assigneeEmployeeId: s("assignee") || undefined, expectedVersion: d.version },
      });
      onDone();
    } catch (err) {
      setError(errText(err, "Could not save"));
    } finally {
      setBusy(false);
    }
  };
  const options = people.data?.items ?? [];
  const hasCurrent = options.some((p) => p.employeeId === d.assignee.employeeId);
  return (
    <form onSubmit={submit} className="card grid gap-3 p-5 sm:grid-cols-3" aria-label="Edit task">
      <div className="sm:col-span-3"><label className="label" htmlFor="e-title">Title</label><input id="e-title" name="title" defaultValue={d.title} required minLength={3} maxLength={200} className="input" /></div>
      <div><label className="label" htmlFor="e-assignee">Assigned to</label>
        <select id="e-assignee" name="assignee" className="input" defaultValue={d.assignee.employeeId} disabled={!people.data}>
          {!hasCurrent && <option value={d.assignee.employeeId}>{d.assignee.name}</option>}
          {options.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.isMe ? `Me (${p.name})` : p.name}</option>)}
        </select></div>
      <div><label className="label" htmlFor="e-priority">Priority</label>
        <select id="e-priority" name="priority" className="input" defaultValue={d.priority}>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>)}</select></div>
      <div><label className="label" htmlFor="e-due">Due date</label><input id="e-due" name="dueDate" type="date" defaultValue={d.dueDate ?? ""} className="input" /></div>
      <div className="sm:col-span-3"><label className="label" htmlFor="e-desc">Details</label><textarea id="e-desc" name="description" rows={4} defaultValue={d.description} maxLength={5000} className="input" /></div>
      {error && <p className="text-sm text-red-700 sm:col-span-3" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-3">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={busy}>Save changes</button>
      </div>
    </form>
  );
}

function Comments({ d, onDone }: { d: Detail; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/tasks/${d.id}/comments`, { method: "POST", body: { body } });
      setBody("");
      onDone();
    } catch (err) {
      setError(errText(err, "Could not post the comment"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="comments">
      <h2 id="comments" className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">Comments</h2>
      <div className="card divide-y divide-line">
        {d.comments.map((c) => (
          <div key={c.id} className="px-4 py-3 text-sm">
            <div className="text-xs text-ink-muted"><span className="font-medium text-ink">{c.isMine ? "You" : c.author}</span> · {formatDate(c.createdAt, true)}</div>
            <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
          </div>
        ))}
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2 p-4">
          <textarea aria-label="Add a comment" rows={2} maxLength={4000} className="input min-w-0 flex-1" placeholder="Add an update or question…" value={body} onChange={(e) => setBody(e.target.value)} />
          <button className="btn-primary" disabled={busy || !body.trim()}>Post</button>
          {error && <p className="w-full text-sm text-red-700" role="alert">{error}</p>}
        </form>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { TASK_PRIORITIES, TASK_PRIORITY_LABEL, type TaskPriority } from "@rstar/shared";
import { api, ApiError } from "@/lib/api";
import { EmptyState, ErrorBox, Loading, PageHeader, useApi } from "@/components/ui";
import { PriorityLabel, TaskStatusChip, dueText, type Assignee, type TaskItem } from "@/components/tasks";

type View = "mine" | "created" | "team";
const VIEWS: { key: View; label: string }[] = [
  { key: "mine", label: "My tasks" },
  { key: "created", label: "Assigned by me" },
  { key: "team", label: "My team" },
];
const STATUS_FILTERS = [
  { key: "active", label: "Open" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

export default function TasksPage() {
  const [view, setView] = useState<View>("mine");
  const [status, setStatus] = useState("active");
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams({ view, status, ...(overdue ? { overdue: "true" } : {}), ...(q ? { q } : {}) });
  const list = useApi<{ items: TaskItem[] }>(`/tasks?${qs}`);

  return (
    <>
      <PageHeader title="Tasks" subtitle="Assign work to your team and track it to done." actions={<button className="btn-primary" onClick={() => setCreating(true)}>New task</button>} />
      {creating && <NewTask onClose={() => setCreating(false)} onSaved={() => { setCreating(false); setView("created"); void list.reload(); }} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-white p-0.5" role="tablist" aria-label="Which tasks">
          {VIEWS.map((v) => (
            <button key={v.key} role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
              className={`rounded-md px-3 py-1.5 text-sm ${view === v.key ? "bg-rstar text-white" : "text-ink-muted hover:text-ink"}`}>{v.label}</button>
          ))}
        </div>
        <select aria-label="Status" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-ink-muted"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Overdue only</label>
        <input aria-label="Search tasks" className="input w-full sm:ml-auto sm:w-64" placeholder="Search title or T-number" onKeyDown={(e) => e.key === "Enter" && setQ((e.target as HTMLInputElement).value.trim())} />
      </div>

      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !list.data?.items.length ? (
        <EmptyState title={view === "mine" ? "No tasks for you here" : view === "created" ? "You haven't assigned any tasks here" : "No team tasks here"}>
          {view !== "mine" && status === "active" ? "Use New task to assign work to someone on your team." : null}
        </EmptyState>
      ) : (
        <ul className="card divide-y divide-line">
          {list.data.items.map((t) => (
            <li key={t.id}>
              <Link href={`/tasks/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-canvas">
                <span className="w-16 shrink-0 font-mono text-xs text-ink-faint">T-{t.number}</span>
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate text-sm font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {view === "mine" ? `From ${t.createdBy.isMe ? "you" : t.createdBy.name}` : `For ${t.assignee.isMe ? "you" : t.assignee.name}`}
                    {t.content ? ` · ${t.content.code}` : ""}
                  </span>
                </span>
                <PriorityLabel priority={t.priority} />
                <span className={`w-32 text-xs sm:text-right ${t.overdue ? "font-medium text-red-700" : "text-ink-muted"}`}>{dueText(t)}</span>
                <TaskStatusChip status={t.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NewTask({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
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
      await api("/tasks", {
        method: "POST",
        body: {
          title: s("title"), description: s("description"), assigneeEmployeeId: s("assignee") || undefined,
          priority: s("priority") as TaskPriority, dueDate: s("dueDate") || null, contentCode: s("contentCode") || null,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not create the task");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card mb-6 grid gap-3 p-4 sm:grid-cols-4" aria-label="New task">
      <div className="sm:col-span-4"><label className="label" htmlFor="t-title">What needs to be done?</label>
        <input id="t-title" name="title" required minLength={3} maxLength={200} className="input" placeholder="e.g. Edit the Avakai recipe reel" autoFocus /></div>
      <div className="sm:col-span-2"><label className="label" htmlFor="t-assignee">Assign to</label>
        <select id="t-assignee" name="assignee" className="input" disabled={!people.data}>
          {people.data?.items.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.isMe ? `Me (${p.name})` : `${p.name} · ${p.department}`}</option>)}
        </select>
        {people.data && people.data.items.length <= 1 && <p className="mt-1 text-xs text-ink-faint">You can assign tasks to yourself and to people who report to you.</p>}
      </div>
      <div><label className="label" htmlFor="t-priority">Priority</label>
        <select id="t-priority" name="priority" className="input" defaultValue="normal">
          {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>)}
        </select></div>
      <div><label className="label" htmlFor="t-due">Due date</label><input id="t-due" name="dueDate" type="date" className="input" /></div>
      <div className="sm:col-span-3"><label className="label" htmlFor="t-desc">Details (optional)</label>
        <textarea id="t-desc" name="description" rows={3} maxLength={5000} className="input" /></div>
      <div><label className="label" htmlFor="t-content">Content ID (optional)</label><input id="t-content" name="contentCode" className="input font-mono" placeholder="e.g. CC001" /></div>
      {error && <p className="text-sm text-red-700 sm:col-span-4" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-4">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy}>{busy ? "Assigning…" : "Create task"}</button>
      </div>
    </form>
  );
}

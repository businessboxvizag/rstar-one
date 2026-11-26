"use client";

import Link from "next/link";
import { use, useState, type FormEvent } from "react";
import type { ContentStage } from "@rstar/shared";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ErrorBox, Loading, StageChip, formatDate, useApi } from "@/components/ui";

interface Action { to: ContentStage; label: string; requiresNote: boolean; ownerRole: string | null }
interface Item {
  id: string; content_code: string; title: string; brief?: string; stage: ContentStage; stage_label: string; version: number;
  client_name: string | null; channel_name: string | null; branch_name?: string; stage_owner_name?: string | null; stage_due_at?: string | null;
  due_at: string | null; priority?: string; format: string; platforms: string[]; revision_count?: number; actions: Action[];
}
interface HistoryRow { id: number; kind: string; from_stage: ContentStage | null; to_stage: ContentStage | null; note: string | null; actor_name: string; assignee_name: string | null; created_at: string }
interface Person { user_id: string; full_name: string; designation_name: string | null; department_name: string }

export default function ContentDetail({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { me } = useAuth();
  const item = useApi<Item>(`/content/${encodeURIComponent(code)}`);
  const history = useApi<{ items: HistoryRow[] }>(me?.user.kind === "staff" ? `/content/${encodeURIComponent(code)}/history` : null);
  const comments = useApi<{ items: { id: string; body: string; author_name: string; created_at: string; visibility: string }[] }>(
    item.data ? `/content/${item.data.id}/comments` : null,
  );

  if (item.error) return <ErrorBox error={item.error} onRetry={item.reload} />;
  if (item.loading || !item.data) return <Loading />;
  const c = item.data;
  const refresh = async () => {
    await item.reload();
    await history.reload();
  };

  return (
    <>
      <nav className="mb-2 text-sm text-ink-muted"><Link href="/production" className="hover:underline">Production</Link> / {c.content_code}</nav>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-rstar px-2.5 py-1 font-mono text-lg font-bold text-white">{c.content_code}</span>
            <StageChip stage={c.stage} />
          </div>
          <h1 className="mt-2 text-xl font-semibold">{c.title}</h1>
          <p className="text-sm text-ink-muted">
            {c.client_name ?? c.channel_name} · {c.format.replace("_", " ")} {c.platforms.length ? `· ${c.platforms.join(", ")}` : ""} {c.branch_name ? `· ${c.branch_name}` : ""}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Actions item={c} onDone={refresh} />
          {c.brief ? (
            <section className="card p-4">
              <h2 className="mb-2 text-sm font-semibold">Brief</h2>
              <p className="whitespace-pre-wrap text-sm text-ink-muted">{c.brief}</p>
            </section>
          ) : null}
          <Comments contentId={c.id} data={comments.data?.items ?? []} reload={comments.reload} isStaff={me?.user.kind === "staff"} />
        </div>
        <aside className="space-y-6">
          <section className="card divide-y divide-line text-sm">
            {[
              ["Current owner", c.stage_owner_name ?? "Unassigned"],
              ["Stage due", formatDate(c.stage_due_at)],
              ["Final deadline", formatDate(c.due_at)],
              ["Priority", c.priority ?? "—"],
              ["Revisions", String(c.revision_count ?? 0)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between px-4 py-2.5"><span className="text-ink-muted">{k}</span><span className="font-medium capitalize">{v}</span></div>
            ))}
          </section>
          {history.data && (
            <section className="card p-4">
              <h2 className="mb-3 text-sm font-semibold">History</h2>
              <ol className="space-y-3 border-l border-line pl-4">
                {[...history.data.items].reverse().map((h) => (
                  <li key={h.id} className="text-sm">
                    <div className="font-medium">
                      {h.kind === "created" ? "Created" : h.kind === "comment" ? "Comment" : h.to_stage ? <StageChip stage={h.to_stage} /> : h.kind}
                    </div>
                    <div className="text-xs text-ink-muted">{h.actor_name} · {formatDate(h.created_at, true)}{h.assignee_name ? ` · assigned to ${h.assignee_name}` : ""}</div>
                    {h.note && <div className="mt-1 rounded bg-canvas px-2 py-1 text-xs">{h.note}</div>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function Actions({ item, onDone }: { item: Item; onDone: () => Promise<void> }) {
  const [active, setActive] = useState<Action | null>(null);
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const people = useApi<{ items: Person[] }>(active?.ownerRole ? `/assignees?role=${active.ownerRole}` : null);

  if (!item.actions.length) {
    return <div className="card px-4 py-3 text-sm text-ink-muted">No actions available to you at this stage.</div>;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/content/${item.id}/transition`, {
        body: {
          to: active.to,
          expectedVersion: item.version,
          ...(note ? { note } : {}),
          ...(assignee ? { assigneeUserId: assignee } : {}),
          ...(due ? { stageDueAt: new Date(due).toISOString() } : {}),
        },
      });
      setActive(null);
      setNote("");
      setAssignee("");
      setDue("");
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">Next step</h2>
      <div className="flex flex-wrap gap-2">
        {item.actions.map((a) => (
          <button key={`${a.to}-${a.label}`} className={a.requiresNote || a.to === "cancelled" ? "btn-danger" : "btn-primary"} onClick={() => { setActive(a); setError(null); }}>
            {a.label}
          </button>
        ))}
      </div>
      {active && (
        <form onSubmit={submit} className="mt-4 space-y-3 rounded-lg border border-line bg-canvas/50 p-4">
          <p className="text-sm font-medium">{active.label}</p>
          {active.ownerRole && (
            <div>
              <label className="label" htmlFor="assignee">Assign to (leave empty to keep the current {active.ownerRole.replace("_", " ")})</label>
              <select id="assignee" className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Keep current</option>
                {people.data?.items.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name} — {p.designation_name ?? p.department_name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="note">{active.requiresNote ? "Reason (required)" : "Note (optional)"}</label>
            <textarea id="note" rows={2} className="input" value={note} required={active.requiresNote} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="due">Due date for the next stage (optional)</label>
            <input id="due" type="datetime-local" className="input max-w-xs" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || (active.requiresNote && !note.trim())}>{busy ? "Saving…" : "Confirm"}</button>
            <button type="button" className="btn-secondary" onClick={() => setActive(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function Comments({ contentId, data, reload, isStaff }: { contentId: string; data: { id: string; body: string; author_name: string; created_at: string; visibility: string }[]; reload: () => Promise<void>; isStaff: boolean }) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState("internal");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/content/${contentId}/comments`, { body: { body, visibility } });
      setBody("");
      await reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">Comments</h2>
      {data.length === 0 && <p className="mb-3 text-sm text-ink-muted">No comments yet.</p>}
      <ul className="mb-4 space-y-3">
        {data.map((m) => (
          <li key={m.id} className="text-sm">
            <span className="font-medium">{m.author_name}</span> <span className="text-xs text-ink-faint">{formatDate(m.created_at, true)}{m.visibility === "client" && isStaff ? " · visible to client" : ""}</span>
            <p className="whitespace-pre-wrap text-ink-muted">{m.body}</p>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="comment" className="sr-only">Add a comment</label>
        <textarea id="comment" rows={2} className="input" placeholder="Add a comment" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex items-center justify-between">
          {isStaff ? (
            <select aria-label="Visibility" className="input max-w-[200px]" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="internal">Internal only</option>
              <option value="client">Visible to client</option>
            </select>
          ) : <span />}
          <button className="btn-primary" disabled={busy || !body.trim()}>Post</button>
        </div>
      </form>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { CONTENT_FORMATS, CONTENT_STAGES, PLATFORMS, PRIORITIES, STAGE_LABELS, type ContentStage } from "@rstar/shared";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { EmptyState, ErrorBox, Loading, PageHeader, StageChip, formatDate, useApi } from "@/components/ui";

interface Row { id: string; content_code: string; title: string; stage: ContentStage; client_name: string | null; channel_name: string | null; branch_name: string; stage_owner_name: string | null; stage_due_at: string | null; priority: string; created_at: string }
interface Owner { id: string; name: string; prefix: string | null }

export default function ProductionPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Production />
    </Suspense>
  );
}

function Production() {
  const params = useSearchParams();
  const router = useRouter();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const q = params.get("q") ?? "";
  const stage = params.get("stage") ?? "";
  const overdue = params.get("overdue") === "true";
  const qs = new URLSearchParams({ limit: "50", ...(q && { q }), ...(stage && { stage }), ...(overdue && { overdue: "true" }) });
  const list = useApi<{ items: Row[]; nextCursor: string | null }>(`/content?${qs}`);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    router.replace(`/production?${next}`);
  };

  return (
    <>
      <PageHeader
        title="Production"
        subtitle="Every item keeps one Content ID from idea to analytics."
        actions={can("content.create") ? <button className="btn-primary" onClick={() => setCreating(true)}>New content</button> : undefined}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <input aria-label="Search" className="input max-w-xs" placeholder="Content ID or title" defaultValue={q} onKeyDown={(e) => e.key === "Enter" && setFilter("q", (e.target as HTMLInputElement).value)} />
        <select aria-label="Stage" className="input max-w-xs" value={stage} onChange={(e) => setFilter("stage", e.target.value)}>
          <option value="">All stages</option>
          {CONTENT_STAGES.map((s) => (
            <option key={s} value={s}>{STAGE_LABELS[s]}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input type="checkbox" checked={overdue} onChange={(e) => setFilter("overdue", e.target.checked ? "true" : "")} /> Overdue only
        </label>
      </div>
      {creating && <CreateContent onClose={() => setCreating(false)} onCreated={(code) => router.push(`/production/${code}`)} />}
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Loading />
      ) : !list.data?.items.length ? (
        <EmptyState title={q || stage || overdue ? "No content matches these filters" : "No content yet"}>
          {can("content.create") ? "Create the first item to allocate a Content ID." : "Items assigned to you will appear here."}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="border-b border-line bg-canvas/60">
              <tr>
                <th className="table-head">Content ID</th>
                <th className="table-head">Title</th>
                <th className="table-head">Client / channel</th>
                <th className="table-head">Stage</th>
                <th className="table-head">Owner</th>
                <th className="table-head">Stage due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data.items.map((c) => (
                <tr key={c.id} className="hover:bg-canvas/60">
                  <td className="table-cell"><Link href={`/production/${c.content_code}`} className="font-mono font-semibold text-rstar hover:underline">{c.content_code}</Link></td>
                  <td className="table-cell max-w-xs truncate">{c.title}</td>
                  <td className="table-cell text-ink-muted">{c.client_name ?? c.channel_name}</td>
                  <td className="table-cell"><StageChip stage={c.stage} /></td>
                  <td className="table-cell text-ink-muted">{c.stage_owner_name ?? "Unassigned"}</td>
                  <td className="table-cell text-ink-muted">{formatDate(c.stage_due_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CreateContent({ onClose, onCreated }: { onClose: () => void; onCreated: (code: string) => void }) {
  const { me } = useAuth();
  const clients = useApi<{ items: Owner[] }>("/clients");
  const channels = useApi<{ items: Owner[] }>("/channels");
  const branches = useApi<{ items: { id: string; name: string; active: boolean }[] }>("/branches");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const [kind, id] = owner.split(":");
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ content_code: string }>("/content", {
        body: {
          title: f.get("title"),
          brief: f.get("brief") || "",
          branchId: f.get("branchId"),
          ...(kind === "client" ? { clientId: id } : { channelId: id }),
          format: f.get("format"),
          priority: f.get("priority"),
          platforms: PLATFORMS.filter((p) => f.get(`platform_${p}`)),
          requiresClientApproval: f.get("requiresClientApproval") === "on",
          ...(f.get("dueAt") ? { dueAt: new Date(String(f.get("dueAt"))).toISOString() } : {}),
          ...(f.get("campaign") ? { campaign: String(f.get("campaign")).toUpperCase() } : {}),
        },
      });
      onCreated(c.content_code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create content");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4" role="dialog" aria-modal aria-labelledby="new-content">
      <form onSubmit={submit} className="card mt-10 w-full max-w-lg space-y-4 p-6 shadow-xl">
        <h2 id="new-content" className="text-lg font-semibold">New content</h2>
        <p className="text-sm text-ink-muted">The Content ID is generated by the server when you save, using the prefix of the selected client or channel.</p>
        <div>
          <label className="label" htmlFor="title">Title</label>
          <input id="title" name="title" required maxLength={200} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="owner">Client or channel</label>
          <select id="owner" required className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Choose…</option>
            <optgroup label="RSTAR channels">
              {channels.data?.items.map((c) => <option key={c.id} value={`channel:${c.id}`}>{c.name} ({c.prefix})</option>)}
            </optgroup>
            <optgroup label="Clients">
              {clients.data?.items.map((c) => <option key={c.id} value={`client:${c.id}`}>{c.name} ({c.prefix})</option>)}
            </optgroup>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="branchId">Branch</label>
            <select key={branches.data ? "ready" : "loading"} id="branchId" name="branchId" required className="input" defaultValue={me?.user.branchId ?? ""}>
              {branches.data?.items.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="format">Format</label>
            <select id="format" name="format" className="input" defaultValue="reel">
              {CONTENT_FORMATS.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="priority">Priority</label>
            <select id="priority" name="priority" className="input" defaultValue="normal">
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dueAt">Deadline</label>
            <input id="dueAt" name="dueAt" type="datetime-local" className="input" />
          </div>
        </div>
        <fieldset>
          <legend className="label">Platforms</legend>
          <div className="flex gap-4 text-sm">
            {PLATFORMS.map((p) => (
              <label key={p} className="flex items-center gap-1.5 capitalize"><input type="checkbox" name={`platform_${p}`} /> {p}</label>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor="brief">Brief</label>
          <textarea id="brief" name="brief" rows={3} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="campaign">Campaign code (only for campaign-numbered clients)</label>
          <input id="campaign" name="campaign" className="input uppercase" maxLength={12} />
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requiresClientApproval" /> Requires client approval</label>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !owner}>{busy ? "Creating…" : "Create and allocate ID"}</button>
        </div>
      </form>
    </div>
  );
}

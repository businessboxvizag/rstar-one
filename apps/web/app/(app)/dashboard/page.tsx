"use client";

import Link from "next/link";
import { STAGE_PHASE, type ContentStage, type StagePhase } from "@rstar/shared";
import { useAuth } from "@/lib/auth";
import { EmptyState, ErrorBox, Loading, PageHeader, StageChip, formatDate, useApi } from "@/components/ui";

interface Pipeline { items: { stage: ContentStage; count: number; overdue: number }[] }
interface ContentList { items: { id: string; content_code: string; title: string; stage: ContentStage; stage_due_at: string | null; client_name: string | null; channel_name: string | null }[] }
interface Notes { items: { id: string; title: string; body: string; created_at: string; read_at: string | null; entity_type: string | null; entity_id: string | null }[]; unread: number }
interface TaskSummary { open: number; overdue: number; dueToday: number }

const PHASES: { key: StagePhase; label: string }[] = [
  { key: "planning", label: "Ideas" },
  { key: "script", label: "Scripting" },
  { key: "shoot", label: "Shooting" },
  { key: "footage", label: "Footage" },
  { key: "edit", label: "Editing" },
  { key: "review", label: "Review" },
  { key: "publish", label: "Publishing" },
  { key: "analytics", label: "Analytics" },
];

export default function DashboardPage() {
  const { me, can } = useAuth();
  const pipeline = useApi<Pipeline>(can("content.read") ? "/content-pipeline" : null);
  const mine = useApi<ContentList>(can("content.read") ? "/content?mine=true&limit=8" : null);
  const notes = useApi<Notes>("/notifications?limit=6");
  const tasks = useApi<TaskSummary>(can("tasks.self") ? "/tasks/summary" : null);

  const byPhase = new Map<StagePhase, { count: number; overdue: number }>();
  for (const r of pipeline.data?.items ?? []) {
    const p = STAGE_PHASE[r.stage];
    const cur = byPhase.get(p) ?? { count: 0, overdue: 0 };
    byPhase.set(p, { count: cur.count + r.count, overdue: cur.overdue + r.overdue });
  }
  const overdueTotal = [...byPhase.values()].reduce((s, x) => s + x.overdue, 0);

  return (
    <>
      <PageHeader title={`Welcome, ${me?.user.displayName.split(" ")[0] ?? ""}`} subtitle="Live figures from the RSTAR ONE database. Attendance, leave, payroll and finance tiles arrive with their modules." />

      {tasks.data && (
        <section aria-labelledby="mytasks" className="mb-6">
          <h2 id="mytasks" className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">My tasks</h2>
          <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
            <Link href="/tasks" className="card p-4 hover:bg-canvas"><div className="text-xs text-ink-muted">Open</div><div className="mt-1 text-2xl font-semibold tabular-nums">{tasks.data.open}</div></Link>
            <Link href="/tasks" className="card p-4 hover:bg-canvas"><div className="text-xs text-ink-muted">Due today</div><div className="mt-1 text-2xl font-semibold tabular-nums">{tasks.data.dueToday}</div></Link>
            <Link href="/tasks" className="card p-4 hover:bg-canvas"><div className="text-xs text-ink-muted">Overdue</div><div className={`mt-1 text-2xl font-semibold tabular-nums ${tasks.data.overdue ? "text-red-700" : ""}`}>{tasks.data.overdue}</div></Link>
          </div>
        </section>
      )}

      {can("content.read") && (
        <section aria-labelledby="pipeline" className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="pipeline" className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Production pipeline</h2>
            {overdueTotal > 0 && <Link href="/production?overdue=true" className="chip bg-red-50 text-red-700">{overdueTotal} overdue</Link>}
          </div>
          {pipeline.error ? (
            <ErrorBox error={pipeline.error} onRetry={pipeline.reload} />
          ) : pipeline.loading ? (
            <Loading />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {PHASES.map((p) => {
                const v = byPhase.get(p.key);
                return (
                  <div key={p.key} className="card p-4">
                    <div className="text-xs text-ink-muted">{p.label}</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{v?.count ?? 0}</div>
                    {v?.overdue ? <div className="text-xs text-red-600">{v.overdue} overdue</div> : <div className="text-xs text-ink-faint">on track</div>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {can("content.read") && (
          <section className="lg:col-span-2" aria-labelledby="mywork">
            <h2 id="mywork" className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">My work</h2>
            {mine.error ? (
              <ErrorBox error={mine.error} onRetry={mine.reload} />
            ) : mine.loading ? (
              <Loading />
            ) : !mine.data?.items.length ? (
              <EmptyState title="Nothing assigned to you right now">Content you own at its current stage appears here.</EmptyState>
            ) : (
              <ul className="card divide-y divide-line">
                {mine.data.items.map((c) => (
                  <li key={c.id}>
                    <Link href={`/production/${c.content_code}`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
                      <span className="w-24 shrink-0 font-mono text-sm font-semibold text-rstar">{c.content_code}</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                      <StageChip stage={c.stage} />
                      <span className="hidden w-28 text-right text-xs text-ink-muted sm:block">{c.stage_due_at ? `due ${formatDate(c.stage_due_at)}` : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section aria-labelledby="notes">
          <h2 id="notes" className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Notifications {notes.data?.unread ? <span className="chip ml-1 bg-rstar text-white">{notes.data.unread}</span> : null}
          </h2>
          {notes.error ? (
            <ErrorBox error={notes.error} onRetry={notes.reload} />
          ) : notes.loading ? (
            <Loading />
          ) : !notes.data?.items.length ? (
            <EmptyState title="You're all caught up" />
          ) : (
            <ul className="card divide-y divide-line">
              {notes.data.items.map((n) => (
                <li key={n.id} className="px-4 py-3">
                  {n.entity_type === "task" && n.entity_id ? (
                    <Link href={`/tasks/${n.entity_id}`} className={`text-sm hover:underline ${n.read_at ? "" : "font-semibold"}`}>{n.title}</Link>
                  ) : (
                    <div className={`text-sm ${n.read_at ? "" : "font-semibold"}`}>{n.title}</div>
                  )}
                  <div className="truncate text-xs text-ink-muted">{n.body}</div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">{formatDate(n.created_at, true)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

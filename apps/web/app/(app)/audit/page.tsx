"use client";

import { Fragment, useState } from "react";
import { EmptyState, ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";

interface Ev { id: number; action: string; entity_type: string; entity_id: string | null; actor_name: string | null; ip: string | null; created_at: string; before: unknown; after: unknown }

export default function AuditPage() {
  const [action, setAction] = useState("");
  const list = useApi<{ items: Ev[] }>(`/audit?limit=100${action ? `&action=${encodeURIComponent(action)}` : ""}`);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of sensitive actions. Entries cannot be edited or deleted." />
      <select aria-label="Filter by action" className="input mb-4 max-w-xs" value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">All actions</option>
        {["auth.", "employee.", "user.", "role.", "content.", "organisation.", "branches.", "client.", "channel."].map((a) => <option key={a} value={a}>{a.replace(".", "")}</option>)}
      </select>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Loading />
      ) : !list.data?.items.length ? (
        <EmptyState title="No audit events" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="border-b border-line bg-canvas/60">
              <tr>{["When", "Who", "Action", "Record", "IP", ""].map((h) => <th key={h} className="table-head">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data.items.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="table-cell whitespace-nowrap text-ink-muted">{formatDate(e.created_at, true)}</td>
                    <td className="table-cell">{e.actor_name ?? "System"}</td>
                    <td className="table-cell font-mono text-xs">{e.action}</td>
                    <td className="table-cell text-xs text-ink-muted">{e.entity_type} {e.entity_id}</td>
                    <td className="table-cell text-xs text-ink-muted">{e.ip ?? "—"}</td>
                    <td className="table-cell text-right">
                      {(e.before || e.after) ? <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? "Hide" : "Details"}</button> : null}
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <td colSpan={6} className="bg-canvas px-4 py-3">
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

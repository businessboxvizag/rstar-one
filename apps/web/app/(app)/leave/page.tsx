"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { EmptyState, ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";
import { StatusChip } from "@/components/attendance";

interface Balance { leaveTypeId: string; code: string; name: string; unlimited: boolean; paid: boolean; opening: number; accrued: number; adjusted: number; used: number; pending: number; available: number | null }
interface LType { id: string; code: string; name: string; allowHalfDay: boolean; active: boolean; requiresDocumentAfterDays: number | null }
interface Req { id: string; employeeName: string; employeeCode: string; leaveTypeCode: string; leaveTypeName: string; startDate: string; endDate: string; startHalf: boolean; endHalf: boolean; days: number; reason: string; status: string; approverName: string | null; decisionNote: string | null; version: number }

export default function LeavePage() {
  const balances = useApi<{ year: number; items: Balance[] }>("/leave/balances");
  const types = useApi<{ items: LType[] }>("/leave/types");
  const mine = useApi<{ items: Req[] }>("/leave/requests?view=mine");
  const review = useApi<{ items: Req[] }>("/leave/requests?view=review&status=pending");
  const [applying, setApplying] = useState(false);
  const reload = () => { void balances.reload(); void mine.reload(); void review.reload(); };

  return (
    <>
      <PageHeader title="Leave" subtitle="Balances, applications and approvals." actions={<button className="btn-primary" onClick={() => setApplying(true)}>Apply for leave</button>} />
      {applying && types.data && <ApplyForm types={types.data.items.filter((t) => t.active)} balances={balances.data?.items ?? []} onClose={() => setApplying(false)} onSaved={reload} />}

      {balances.error ? <ErrorBox error={balances.error} onRetry={balances.reload} /> : balances.loading && !balances.data ? <Loading /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {balances.data?.items.map((b) => (
            <div key={b.leaveTypeId} className="card p-4">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">{b.name}</span><span className="font-mono text-xs text-ink-muted">{b.code}</span></div>
              <div className="mt-2 text-2xl font-semibold">{b.unlimited ? "—" : b.available}<span className="ml-1 text-sm font-normal text-ink-muted">{b.unlimited ? (b.paid ? "no limit" : "unpaid, no limit") : "days available"}</span></div>
              <div className="mt-1 text-xs text-ink-muted">Credited {b.opening + b.accrued + b.adjusted} · used {b.used}{b.pending ? ` · pending ${b.pending}` : ""}</div>
            </div>
          ))}
        </div>
      )}

      {(review.data?.items.length ?? 0) > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-semibold">Waiting for your approval</h2>
          <div className="card divide-y divide-line">{review.data!.items.map((r) => <ReviewRow key={r.id} r={r} onDone={reload} />)}</div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 font-semibold">My requests</h2>
        {mine.error ? <ErrorBox error={mine.error} /> : !mine.data?.items.length ? <EmptyState title="No leave requests yet" /> : (
          <div className="card divide-y divide-line">
            {mine.data.items.map((r) => <MyRow key={r.id} r={r} onDone={reload} />)}
          </div>
        )}
      </section>
    </>
  );
}

const span = (r: Req) =>
  `${formatDate(r.startDate)}${r.startHalf ? " (2nd half)" : ""}${r.endDate !== r.startDate ? ` – ${formatDate(r.endDate)}${r.endHalf ? " (1st half)" : ""}` : r.endHalf ? " (1st half)" : ""}`;

function MyRow({ r, onDone }: { r: Req; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const canCancel = r.status === "pending" || (r.status === "approved" && r.startDate > today);
  const cancel = async () => {
    let reason: string | undefined;
    if (r.status === "approved") {
      reason = window.prompt("Reason for cancelling approved leave")?.trim();
      if (!reason) return;
    }
    try {
      await api(`/leave/requests/${r.id}/cancel`, { method: "POST", body: { reason } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div>
        <div className="font-medium">{r.leaveTypeName} · {r.days} day{r.days === 1 ? "" : "s"} · {span(r)}</div>
        <div className="text-ink-muted">{r.reason}{r.approverName && r.status === "pending" ? ` · with ${r.approverName}` : ""}{r.decisionNote ? ` · “${r.decisionNote}”` : ""}</div>
        {error && <div className="text-red-700" role="alert">{error}</div>}
      </div>
      <div className="flex items-center gap-2">
        <StatusChip status={r.status} />
        {canCancel && <button className="btn-ghost text-xs" onClick={cancel}>{r.status === "pending" ? "Withdraw" : "Cancel"}</button>}
      </div>
    </div>
  );
}

function ReviewRow({ r, onDone }: { r: Req; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/leave/requests/${r.id}/decide`, { method: "POST", body: { decision, note: note || undefined, expectedVersion: r.version } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{r.employeeName} <span className="font-mono text-xs text-ink-muted">{r.employeeCode}</span> · {r.leaveTypeName} · {r.days} day{r.days === 1 ? "" : "s"}</div>
        <div className="text-ink-muted">{span(r)} · {r.reason}</div>
        {error && <div className="text-red-700" role="alert">{error}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Note" className="input w-48" placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn-danger" disabled={busy} onClick={() => decide("reject")}>Reject</button>
        <button className="btn-primary" disabled={busy} onClick={() => decide("approve")}>Approve</button>
      </div>
    </div>
  );
}

function ApplyForm({ types, balances, onClose, onSaved }: { types: LType[]; balances: Balance[]; onClose: () => void; onSaved: () => void }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [startHalf, setStartHalf] = useState(false);
  const [endHalf, setEndHalf] = useState(false);
  const [reason, setReason] = useState("");
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = types.find((t) => t.id === typeId);
  const bal = balances.find((b) => b.leaveTypeId === typeId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/leave/requests", { method: "POST", body: { leaveTypeId: typeId, startDate: start, endDate: end || start, startHalf, endHalf, reason, documentRef: doc || undefined } });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not apply");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card mb-6 grid gap-3 p-4 sm:grid-cols-4">
      <div><label className="label" htmlFor="l-type">Leave type</label>
        <select id="l-type" className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {bal && <p className="mt-1 text-xs text-ink-muted">{bal.unlimited ? "No balance limit" : `${bal.available} day(s) available`}</p>}
      </div>
      <div><label className="label" htmlFor="l-start">From</label><input id="l-start" type="date" required className="input" value={start} onChange={(e) => setStart(e.target.value)} />
        {type?.allowHalfDay && <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted"><input type="checkbox" checked={startHalf} onChange={(e) => setStartHalf(e.target.checked)} /> Start after lunch</label>}
      </div>
      <div><label className="label" htmlFor="l-end">To</label><input id="l-end" type="date" className="input" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
        {type?.allowHalfDay && <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted"><input type="checkbox" checked={endHalf} onChange={(e) => setEndHalf(e.target.checked)} /> End at lunch</label>}
      </div>
      <div><label className="label" htmlFor="l-reason">Reason</label><input id="l-reason" required minLength={3} className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {type?.requiresDocumentAfterDays != null && (
        <div className="sm:col-span-4"><label className="label" htmlFor="l-doc">Supporting document (needed for more than {type.requiresDocumentAfterDays} day(s))</label>
          <input id="l-doc" className="input" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="e.g. Medical certificate given to HR on 12 Dec" />
          <p className="mt-1 text-xs text-ink-faint">File upload arrives with the media storage milestone; for now describe the document.</p>
        </div>
      )}
      {error && <p className="text-sm text-red-700 sm:col-span-4" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-4">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy}>Apply</button>
      </div>
    </form>
  );
}

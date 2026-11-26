"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { EmptyState, ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";
import { DayChip, ResultChip, hours, time } from "@/components/attendance";

interface Day { work_date: string; status: string; first_in: string | null; last_out: string | null; worked_minutes: number; needs_review: boolean }
interface Row { id: string; employee_code: string; full_name: string; branch_name: string; department_name: string; days: Day[]; summary: { present: number; late: number; halfDay: number; absent: number; onLeave: number; needsReview: number; workedMinutes: number } }
interface Ev { id: number; employeeName: string; employeeCode: string; workDate: string; kind: string; mode: string; serverTime: string; distanceM: number | null; accuracyM: number | null; latitude: number | null; longitude: number | null; flags: { code: string; label: string }[]; result: string; note: string | null }
interface Corr { id: string; employeeName: string; employeeCode: string; workDate: string; checkInAt: string | null; checkOutAt: string | null; reason: string; status: string }

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export default function TeamAttendancePage() {
  const [date, setDate] = useState(todayIst());
  const reg = useApi<{ employees: Row[] }>(`/attendance/register?from=${date}&to=${date}`);
  const exc = useApi<{ items: Ev[] }>("/attendance/exceptions");
  const corr = useApi<{ items: Corr[] }>("/attendance/corrections?view=review&status=pending");
  const reload = () => { void reg.reload(); void exc.reload(); void corr.reload(); };

  return (
    <>
      <PageHeader title="Team attendance" subtitle="People you manage or oversee, with anything waiting for your review." />

      <Section title={`Waiting for review (${(exc.data?.items.length ?? 0) + (corr.data?.items.length ?? 0)})`}>
        {exc.error ? <ErrorBox error={exc.error} /> : corr.error ? <ErrorBox error={corr.error} /> : exc.loading && !exc.data ? <Loading /> : !exc.data?.items.length && !corr.data?.items.length ? (
          <EmptyState title="Nothing to review">Flagged check-ins and correction requests from your team appear here.</EmptyState>
        ) : (
          <div className="card divide-y divide-line">
            {exc.data?.items.map((e) => (
              <ReviewRow key={`e${e.id}`} path={`/attendance/events/${e.id}/review`} onDone={reload}
                title={<>{e.employeeName} <span className="font-mono text-xs text-ink-muted">{e.employeeCode}</span> · {e.kind === "check_in" ? "check-in" : "check-out"} {time(e.serverTime)} {formatDate(e.workDate)} · <span className="capitalize">{e.mode}</span></>}
                detail={<>
                  {e.flags.map((f) => f.label).join("; ")}
                  {e.distanceM != null && ` · ${Math.round(e.distanceM)} m from office`}
                  {e.accuracyM != null && ` · ±${Math.round(e.accuracyM)} m`}
                  {e.latitude != null && <> · <a className="text-rstar underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${e.latitude}&mlon=${e.longitude}#map=17/${e.latitude}/${e.longitude}`}>map</a></>}
                  {e.note && ` · “${e.note}”`}
                </>} badge={<ResultChip result={e.result} />} />
            ))}
            {corr.data?.items.map((c) => (
              <ReviewRow key={`c${c.id}`} path={`/attendance/corrections/${c.id}/review`} onDone={reload}
                title={<>{c.employeeName} <span className="font-mono text-xs text-ink-muted">{c.employeeCode}</span> · correction for {formatDate(c.workDate)}</>}
                detail={<>In {time(c.checkInAt)} · out {time(c.checkOutAt)} · {c.reason}</>} badge={<span className="chip bg-amber-50 text-amber-800">Correction</span>} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Daily register" actions={<input type="date" aria-label="Register date" className="input w-auto" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />}>
        {reg.error ? <ErrorBox error={reg.error} onRetry={reg.reload} /> : reg.loading && !reg.data ? <Loading /> : !reg.data?.employees.length ? <EmptyState title="No one to show" /> : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-line bg-canvas/60"><tr>{["Employee", "Branch", "Department", "Status", "In", "Out", "Worked"].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {reg.data.employees.map((r) => {
                  const d = r.days[0];
                  return (
                    <tr key={r.id}>
                      <td className="table-cell"><div className="font-medium">{r.full_name}</div><div className="font-mono text-xs text-ink-muted">{r.employee_code}</div></td>
                      <td className="table-cell">{r.branch_name}</td>
                      <td className="table-cell">{r.department_name}</td>
                      <td className="table-cell">{d ? <DayChip status={d.status} /> : <span className="text-ink-faint">—</span>}</td>
                      <td className="table-cell">{time(d?.first_in)}</td>
                      <td className="table-cell">{time(d?.last_out)}</td>
                      <td className="table-cell">{hours(d?.worked_minutes ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">{title}</h2>{actions}</div>
      {children}
    </section>
  );
}

function ReviewRow({ title, detail, badge, path, onDone }: { title: React.ReactNode; detail: React.ReactNode; badge: React.ReactNode; path: string; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: { decision, note: note || undefined } });
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
        <div className="font-medium">{title}</div>
        <div className="text-ink-muted">{detail}</div>
        {error && <div className="text-red-700" role="alert">{error}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {badge}
        <input aria-label="Note" className="input w-48" placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn-danger" disabled={busy} onClick={() => decide("reject")}>Reject</button>
        <button className="btn-primary" disabled={busy} onClick={() => decide("approve")}>Approve</button>
      </div>
    </div>
  );
}

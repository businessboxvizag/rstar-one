"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { EmptyState, ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";
import { DayChip, ResultChip, StatusChip, getFix, hours, time } from "@/components/attendance";

interface Flag { code: string; label: string }
interface Ev { id: number; kind: string; mode: string; serverTime: string; result: string; flags: Flag[]; distanceM: number | null; accuracyM: number | null; reviewNote: string | null }
interface Day { work_date: string; status: string; first_in: string | null; last_out: string | null; worked_minutes: number; late_minutes: number; early_minutes: number; source: string; needs_review: boolean }
interface Today {
  date: string; checkedIn: boolean; openSince: string | null; events: Ev[]; day: Day | null;
  office: { configured: boolean; radiusM?: number };
  policy: { workStart: string; workEnd: string; allowWfh: boolean; allowField: boolean };
  consent: { given: boolean; version: string };
}
interface Summary { present: number; late: number; halfDay: number; absent: number; onLeave: number; holidays: number; needsReview: number; workedMinutes: number }
interface Correction { id: string; workDate: string; checkInAt: string | null; checkOutAt: string | null; reason: string; status: string; kind: string; decisionNote: string | null }

const MODES = [
  { key: "office", label: "Office" },
  { key: "field", label: "Field / shoot" },
  { key: "wfh", label: "Work from home" },
] as const;

function monthRange(offset: number) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(first), to: iso(last), label: first.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
}

export default function AttendancePage() {
  const today = useApi<Today>("/attendance/me/today");
  const [month, setMonth] = useState(0);
  const range = monthRange(month);
  const ledger = useApi<{ days: Day[]; summary: Summary }>(`/attendance/me?from=${range.from}&to=${range.to}`);
  const corrections = useApi<{ items: Correction[] }>("/attendance/corrections?view=mine");
  const [correcting, setCorrecting] = useState<string | null>(null);
  const reloadAll = () => { void today.reload(); void ledger.reload(); void corrections.reload(); };

  return (
    <>
      <PageHeader title="My attendance" subtitle="Check in and out with your location. Location is captured only at the moment you tap, never tracked in the background." />
      {today.error ? <ErrorBox error={today.error} onRetry={today.reload} /> : today.loading && !today.data ? <Loading /> : today.data && <TodayCard t={today.data} onChange={reloadAll} />}

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{range.label}</h2>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setMonth(month - 1)}>Previous</button>
            <button className="btn-secondary" disabled={month >= 0} onClick={() => setMonth(month + 1)}>Next</button>
            <button className="btn-primary" onClick={() => setCorrecting("")}>Request correction</button>
          </div>
        </div>
        {ledger.data && (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {[["Present", ledger.data.summary.present], ["Late", ledger.data.summary.late], ["Half day", ledger.data.summary.halfDay], ["Absent", ledger.data.summary.absent], ["Leave", ledger.data.summary.onLeave], ["Needs review", ledger.data.summary.needsReview]].map(([k, v]) => (
              <span key={k} className="card px-3 py-1.5"><span className="text-ink-muted">{k}</span> <b className="ml-1">{v}</b></span>
            ))}
            <span className="card px-3 py-1.5"><span className="text-ink-muted">Worked</span> <b className="ml-1">{hours(ledger.data.summary.workedMinutes)}</b></span>
          </div>
        )}
        {correcting !== null && <CorrectionForm initialDate={correcting} onClose={() => setCorrecting(null)} onSaved={reloadAll} />}
        {ledger.error ? <ErrorBox error={ledger.error} onRetry={ledger.reload} /> : ledger.loading && !ledger.data ? <Loading /> : !ledger.data?.days.length ? (
          <EmptyState title="No attendance days yet for this month" />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="border-b border-line bg-canvas/60"><tr>{["Date", "Status", "In", "Out", "Worked", "Late", ""].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {[...ledger.data.days].reverse().map((d) => (
                  <tr key={d.work_date}>
                    <td className="table-cell">{formatDate(d.work_date)}</td>
                    <td className="table-cell"><DayChip status={d.status} />{d.source === "correction" && <span className="ml-1 text-xs text-ink-muted">corrected</span>}</td>
                    <td className="table-cell">{time(d.first_in)}</td>
                    <td className="table-cell">{time(d.last_out)}</td>
                    <td className="table-cell">{hours(d.worked_minutes)}</td>
                    <td className="table-cell text-ink-muted">{d.late_minutes ? `${d.late_minutes} min` : "—"}</td>
                    <td className="table-cell text-right">
                      {["absent", "pending_review", "half_day", "late"].includes(d.status) && <button className="btn-ghost text-xs" onClick={() => setCorrecting(d.work_date)}>Correct</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-semibold">My correction requests</h2>
        {corrections.error ? <ErrorBox error={corrections.error} /> : !corrections.data?.items.length ? <EmptyState title="No correction requests" /> : (
          <div className="card divide-y divide-line">
            {corrections.data.items.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div>
                  <div className="font-medium">{formatDate(c.workDate)} · in {time(c.checkInAt)} · out {time(c.checkOutAt)} {c.kind === "manual" && <span className="text-xs text-ink-muted">(entered by HR / manager)</span>}</div>
                  <div className="text-ink-muted">{c.reason}{c.decisionNote ? ` — ${c.decisionNote}` : ""}</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip status={c.status} />
                  {c.status === "pending" && (
                    <button className="btn-ghost text-xs" onClick={async () => { await api(`/attendance/corrections/${c.id}/withdraw`, { method: "POST", body: {} }); reloadAll(); }}>Withdraw</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function TodayCard({ t, onChange }: { t: Today; onChange: () => void }) {
  const [mode, setMode] = useState<"office" | "field" | "wfh">("office");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const kind = t.checkedIn ? "check_out" : "check_in";

  const submit = async () => {
    setError(null);
    setNotice(null);
    if (!t.consent.given && mode !== "wfh") return setShowConsent(true);
    setBusy(true);
    try {
      let fix: { latitude: number; longitude: number; accuracyM: number } | null = null;
      if (t.consent.given) {
        try {
          fix = await getFix();
        } catch (e) {
          if (mode !== "wfh") throw e; // WFH can be recorded without a location
        }
      }
      const ev = await api<Ev>("/attendance/events", {
        method: "POST",
        body: { kind, mode, ...(fix ?? {}), clientTime: new Date().toISOString(), idempotencyKey: crypto.randomUUID() },
      });
      setNotice(ev.result === "pending_exception"
        ? `Recorded, but it needs review: ${ev.flags.map((f) => f.label).join("; ")}. Your manager has been notified.`
        : `${kind === "check_in" ? "Checked in" : "Checked out"} at ${time(ev.serverTime)}${ev.distanceM != null ? ` · ${Math.round(ev.distanceM)} m from office` : ""}.`);
      onChange();
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { code?: string } | undefined) : undefined;
      if (d?.code === "consent_required") setShowConsent(true);
      else setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-muted">{formatDate(t.date)} · office hours {t.policy.workStart}–{t.policy.workEnd}</p>
          <p className="mt-1 text-lg font-semibold">
            {t.checkedIn ? `Checked in since ${time(t.openSince)}` : t.events.length ? "Checked out" : "Not checked in yet"}
          </p>
          {t.day && <div className="mt-1 flex items-center gap-2 text-sm"><DayChip status={t.day.status} /><span className="text-ink-muted">{hours(t.day.worked_minutes)} worked</span></div>}
          {!t.office.configured && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Your office location has not been set up yet, so office check-ins are sent for review instead of being verified automatically.</p>}
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:min-w-[260px]">
          {!t.checkedIn && (
            <div className="flex rounded-lg border border-line p-0.5 text-sm" role="radiogroup" aria-label="Where are you working?">
              {MODES.filter((m) => m.key === "office" || (m.key === "wfh" ? t.policy.allowWfh : t.policy.allowField)).map((m) => (
                <button key={m.key} role="radio" aria-checked={mode === m.key} onClick={() => setMode(m.key)} className={`flex-1 rounded-md px-2 py-1.5 ${mode === m.key ? "bg-rstar text-white" : "text-ink-muted hover:bg-canvas"}`}>{m.label}</button>
              ))}
            </div>
          )}
          <button className={t.checkedIn ? "btn-secondary py-3 text-base" : "btn-primary py-3 text-base"} disabled={busy} onClick={submit}>
            {busy ? "Getting your location…" : t.checkedIn ? "Check out" : "Check in"}
          </button>
        </div>
      </div>
      {notice && <p className="mt-4 rounded-lg bg-canvas px-3 py-2 text-sm" role="status">{notice}</p>}
      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
      {t.events.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line text-sm">
          {t.events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{e.kind === "check_in" ? "In" : "Out"} {time(e.serverTime)} · <span className="capitalize text-ink-muted">{e.mode === "wfh" ? "WFH" : e.mode}</span>
                {e.accuracyM != null && <span className="text-ink-muted"> · ±{Math.round(e.accuracyM)} m</span>}</span>
              <span className="flex items-center gap-2">{e.flags.length > 0 && <span className="text-xs text-ink-muted">{e.flags.map((f) => f.label).join("; ")}</span>}<ResultChip result={e.result} /></span>
            </li>
          ))}
        </ul>
      )}
      {showConsent && <ConsentDialog version={t.consent.version} onClose={() => setShowConsent(false)} onAccepted={() => { setShowConsent(false); onChange(); }} />}
    </div>
  );
}

function ConsentDialog({ version, onClose, onAccepted }: { version: string; onClose: () => void; onAccepted: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="card max-w-lg p-6">
        <h2 id="consent-title" className="text-lg font-semibold">How RSTAR ONE uses your location</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-muted">
          <li>Your location is read <b>only when you tap Check in or Check out</b>. There is no background or continuous tracking.</li>
          <li>It is compared with your office&apos;s geofence on our server to verify attendance.</li>
          <li>Your reporting manager, HR and administrators can see the time, distance from office and accuracy of each check.</li>
          <li>Location records are kept with your attendance history and every review is audited.</li>
          <li>If you work from home or at a shoot, choose that option. Anything unusual is sent to your manager to review, not rejected automatically.</li>
        </ul>
        <p className="mt-3 text-xs text-ink-faint">Notice version {version}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Not now</button>
          <button className="btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await api("/attendance/consent", { method: "POST", body: {} }); onAccepted(); } finally { setBusy(false); } }}>I understand, continue</button>
        </div>
      </div>
    </div>
  );
}

function CorrectionForm({ initialDate, onClose, onSaved }: { initialDate: string; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(initialDate);
  const [inT, setIn] = useState("");
  const [outT, setOut] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const at = (t: string) => (t ? `${date}T${t}:00+05:30` : null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/attendance/corrections", { method: "POST", body: { workDate: date, checkInAt: at(inT), checkOutAt: at(outT), reason } });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card mb-4 grid gap-3 p-4 sm:grid-cols-5">
      <div><label className="label" htmlFor="c-date">Date</label><input id="c-date" type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div><label className="label" htmlFor="c-in">Check-in time</label><input id="c-in" type="time" className="input" value={inT} onChange={(e) => setIn(e.target.value)} /></div>
      <div><label className="label" htmlFor="c-out">Check-out time</label><input id="c-out" type="time" className="input" value={outT} onChange={(e) => setOut(e.target.value)} /></div>
      <div className="sm:col-span-2"><label className="label" htmlFor="c-reason">Reason</label><input id="c-reason" className="input" required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to check out after the night shoot" /></div>
      {error && <p className="text-sm text-red-700 sm:col-span-5" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-5">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || (!inT && !outT)}>Send to my manager</button>
      </div>
    </form>
  );
}

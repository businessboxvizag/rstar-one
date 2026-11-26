"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { EmptyState, ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";
import { getFix } from "@/components/attendance";

interface Branch { branchId: string; code: string; name: string; geofence: { latitude: number; longitude: number; radiusM: number; maxAccuracyM: number; active: boolean; updatedAt: string } | null }
interface Policy { workStart: string; workEnd: string; graceMinutes: number; earlyLeaveMinutes: number; halfDayMinutes: number; fullDayMinutes: number; weeklyOffs: number[]; allowWfh: boolean; allowField: boolean; source: string }
interface Holiday { id: string; holiday_date: string; name: string; optional: boolean; branch_name: string | null }
interface LType { id: string; code: string; name: string; paid: boolean; annualQuota: number; accrual: string; carryForwardMax: number; allowHalfDay: boolean; requiresDocumentAfterDays: number | null; unlimited: boolean; active: boolean }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SetupPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Attendance & leave setup" subtitle="Office geofences, working hours, holidays and leave rules. Every change is audited." />
      {can("attendance.configure") && <><Geofences /><PolicyForm /><Holidays /></>}
      {can("leave.configure") && <LeaveTypes />}
    </>
  );
}

function Card({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mb-3 text-sm text-ink-muted">{hint}</p>}
      {children}
    </section>
  );
}

function Geofences() {
  const list = useApi<{ items: Branch[] }>("/attendance/geofences");
  return (
    <Card title="Office geofences" hint="Stand inside the office and use “Use my current location”, or paste coordinates from a map. Until a branch is set, office check-ins there go to review.">
      {list.error ? <ErrorBox error={list.error} /> : list.loading && !list.data ? <Loading /> : (
        <div className="grid gap-3 md:grid-cols-2">{list.data?.items.map((b) => <GeofenceEditor key={b.branchId} b={b} onSaved={list.reload} />)}</div>
      )}
    </Card>
  );
}

function GeofenceEditor({ b, onSaved }: { b: Branch; onSaved: () => void }) {
  const [lat, setLat] = useState(b.geofence?.latitude?.toString() ?? "");
  const [lng, setLng] = useState(b.geofence?.longitude?.toString() ?? "");
  const [radius, setRadius] = useState(String(b.geofence?.radiusM ?? 150));
  const [acc, setAcc] = useState(String(b.geofence?.maxAccuracyM ?? 100));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api(`/attendance/geofences/${b.branchId}`, { method: "PUT", body: { latitude: Number(lat), longitude: Number(lng), radiusM: Number(radius), maxAccuracyM: Number(acc), active: true } });
      setMsg("Saved");
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  const here = async () => {
    setMsg("Getting location…");
    try {
      const f = await getFix();
      setLat(f.latitude.toFixed(6));
      setLng(f.longitude.toFixed(6));
      setMsg(`Location captured (±${f.accuracyM} m). Check it, then save.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <form onSubmit={save} className="card grid grid-cols-2 gap-3 p-4">
      <div className="col-span-2 flex items-center justify-between">
        <span className="font-medium">{b.name} <span className="font-mono text-xs text-ink-muted">{b.code}</span></span>
        {b.geofence ? <span className="chip bg-emerald-50 text-emerald-800">Set {formatDate(b.geofence.updatedAt)}</span> : <span className="chip bg-amber-50 text-amber-800">Not set</span>}
      </div>
      <div><label className="label">Latitude</label><input className="input" required inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} /></div>
      <div><label className="label">Longitude</label><input className="input" required inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} /></div>
      <div><label className="label">Radius (m)</label><input className="input" type="number" min={25} max={5000} value={radius} onChange={(e) => setRadius(e.target.value)} /></div>
      <div><label className="label">Worst accepted accuracy (m)</label><input className="input" type="number" min={5} max={2000} value={acc} onChange={(e) => setAcc(e.target.value)} /></div>
      <div className="col-span-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-muted">{msg}</span>
        <div className="flex gap-2"><button type="button" className="btn-secondary" onClick={here}>Use my current location</button><button className="btn-primary" disabled={busy}>Save</button></div>
      </div>
    </form>
  );
}

function PolicyForm() {
  const pol = useApi<Policy>("/attendance/policy");
  if (pol.error) return <ErrorBox error={pol.error} />;
  if (!pol.data) return <Loading />;
  return <PolicyEditor p={pol.data} onSaved={pol.reload} />;
}

function PolicyEditor({ p, onSaved }: { p: Policy; onSaved: () => void }) {
  const [v, setV] = useState(p);
  const [msg, setMsg] = useState<string | null>(null);
  const num = (k: keyof Policy) => ({ type: "number", className: "input", value: String(v[k]), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) }) });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { source: _s, ...body } = v;
      await api("/attendance/policy", { method: "PUT", body });
      setMsg("Saved");
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed");
    }
  };
  return (
    <Card title="Working hours and rules" hint="Applies to all branches (organisation default).">
      <form onSubmit={save} className="card grid gap-3 p-4 sm:grid-cols-4">
        <div><label className="label">Work starts</label><input type="time" className="input" value={v.workStart} onChange={(e) => setV({ ...v, workStart: e.target.value })} /></div>
        <div><label className="label">Work ends</label><input type="time" className="input" value={v.workEnd} onChange={(e) => setV({ ...v, workEnd: e.target.value })} /></div>
        <div><label className="label">Late after (grace, min)</label><input {...num("graceMinutes")} /></div>
        <div><label className="label">Early-leave tolerance (min)</label><input {...num("earlyLeaveMinutes")} /></div>
        <div><label className="label">Half day needs (min)</label><input {...num("halfDayMinutes")} /></div>
        <div><label className="label">Full day needs (min)</label><input {...num("fullDayMinutes")} /></div>
        <div className="sm:col-span-2"><span className="label">Weekly offs</span>
          <div className="flex flex-wrap gap-1.5">{DAYS.map((d, i) => (
            <label key={d} className={`chip cursor-pointer border ${v.weeklyOffs.includes(i) ? "border-rstar bg-rstar/10 text-rstar" : "border-line text-ink-muted"}`}>
              <input type="checkbox" className="sr-only" checked={v.weeklyOffs.includes(i)} onChange={(e) => setV({ ...v, weeklyOffs: e.target.checked ? [...v.weeklyOffs, i].sort() : v.weeklyOffs.filter((x) => x !== i) })} />{d}
            </label>
          ))}</div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.allowWfh} onChange={(e) => setV({ ...v, allowWfh: e.target.checked })} /> Allow work from home</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.allowField} onChange={(e) => setV({ ...v, allowField: e.target.checked })} /> Allow field / shoot check-in</label>
        <div className="flex items-center justify-end gap-3 sm:col-span-2"><span className="text-xs text-ink-muted">{msg}</span><button className="btn-primary">Save rules</button></div>
      </form>
    </Card>
  );
}

function Holidays() {
  const year = Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 4));
  const [y, setY] = useState(year);
  const list = useApi<{ items: Holiday[] }>(`/holidays?year=${y}`);
  const branches = useApi<{ items: Branch[] }>("/attendance/geofences");
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/holidays", { method: "POST", body: { holidayDate: date, name, branchId: branchId || null } });
      setDate("");
      setName("");
      void list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };
  return (
    <Card title="Holidays" hint="Holidays are not counted as leave and show as holidays in the register.">
      <form onSubmit={add} className="card mb-3 grid gap-3 p-4 sm:grid-cols-5">
        <div><label className="label">Date</label><input type="date" required className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label">Name</label><input required minLength={2} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sankranti" /></div>
        <div><label className="label">Branch</label><select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All branches</option>{branches.data?.items.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}</select></div>
        <div className="flex items-end"><button className="btn-primary w-full">Add holiday</button></div>
        {error && <p className="text-sm text-red-700 sm:col-span-5" role="alert">{error}</p>}
      </form>
      <div className="mb-2 flex items-center gap-2 text-sm"><button className="btn-ghost" onClick={() => setY(y - 1)}>‹</button><b>{y}</b><button className="btn-ghost" onClick={() => setY(y + 1)}>›</button></div>
      {!list.data?.items.length ? <EmptyState title={`No holidays added for ${y}`} /> : (
        <div className="card divide-y divide-line">
          {list.data.items.map((h) => (
            <div key={h.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span>{formatDate(h.holiday_date)} · <b>{h.name}</b> <span className="text-ink-muted">· {h.branch_name ?? "All branches"}</span></span>
              <button className="btn-ghost text-xs" onClick={async () => { await api(`/holidays/${h.id}`, { method: "DELETE" }); void list.reload(); }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function LeaveTypes() {
  const list = useApi<{ items: LType[] }>("/leave/types");
  const [error, setError] = useState<string | null>(null);
  const patch = async (t: LType, body: Partial<LType>) => {
    setError(null);
    try {
      await api(`/leave/types/${t.id}`, { method: "PATCH", body });
      void list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <Card title="Leave types" hint="Starting values are common Indian defaults. Change quotas to match your HR policy before people start applying.">
      {error && <ErrorBox error={error} />}
      {list.loading && !list.data ? <Loading /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="border-b border-line bg-canvas/60"><tr>{["Type", "Days / year", "Accrual", "Carry forward max", "Half day", "Document after", "Paid", "Active"].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {list.data?.items.map((t) => (
                <tr key={t.id}>
                  <td className="table-cell"><b>{t.name}</b> <span className="font-mono text-xs text-ink-muted">{t.code}</span></td>
                  <td className="table-cell">{t.unlimited ? "No limit" : <input aria-label={`${t.name} quota`} type="number" step="0.5" min={0} className="input w-20" defaultValue={t.annualQuota} onBlur={(e) => Number(e.target.value) !== t.annualQuota && patch(t, { annualQuota: Number(e.target.value) })} />}</td>
                  <td className="table-cell">
                    <select aria-label={`${t.name} accrual`} className="input w-28" value={t.accrual} onChange={(e) => patch(t, { accrual: e.target.value })}>
                      <option value="yearly">Yearly</option><option value="monthly">Monthly</option><option value="none">None</option>
                    </select>
                  </td>
                  <td className="table-cell"><input aria-label={`${t.name} carry forward`} type="number" step="0.5" min={0} className="input w-20" defaultValue={t.carryForwardMax} onBlur={(e) => Number(e.target.value) !== t.carryForwardMax && patch(t, { carryForwardMax: Number(e.target.value) })} /></td>
                  <td className="table-cell"><input type="checkbox" aria-label={`${t.name} half day`} checked={t.allowHalfDay} onChange={(e) => patch(t, { allowHalfDay: e.target.checked })} /></td>
                  <td className="table-cell text-ink-muted">{t.requiresDocumentAfterDays != null ? `${t.requiresDocumentAfterDays} days` : "—"}</td>
                  <td className="table-cell text-ink-muted">{t.paid ? "Paid" : "Unpaid"}</td>
                  <td className="table-cell"><input type="checkbox" aria-label={`${t.name} active`} checked={t.active} onChange={(e) => patch(t, { active: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

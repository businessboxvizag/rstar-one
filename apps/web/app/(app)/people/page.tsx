"use client";

import { useState, type FormEvent } from "react";
import { EMPLOYMENT_TYPES } from "@rstar/shared";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { EmptyState, ErrorBox, Loading, PageHeader, formatDate, useApi } from "@/components/ui";

interface Emp { id: string; employee_code: string; full_name: string; email: string; branch_name: string; department_name: string; designation_name: string | null; reporting_manager_name: string | null; status: string; account_status: string; joining_date: string }
interface Opt { id: string; name: string; active?: boolean }
interface Role { key: string; name: string; mfa_required: boolean; audience: string }

export default function PeoplePage() {
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Emp | null>(null);
  const list = useApi<{ items: Emp[] }>(`/employees?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const canAdd = can("employees.manage") && can("users.manage");

  return (
    <>
      <PageHeader title="People" subtitle="Employees you are allowed to see, based on your role." actions={canAdd ? <button className="btn-primary" onClick={() => setAdding(true)}>Add employee</button> : undefined} />
      <input aria-label="Search people" className="input mb-4 max-w-sm" placeholder="Search name, employee ID or email" onKeyDown={(e) => e.key === "Enter" && setQ((e.target as HTMLInputElement).value)} />
      {adding && <AddEmployee onClose={() => setAdding(false)} onSaved={list.reload} />}
      {resetting && <ResetAccess emp={resetting} onClose={() => setResetting(null)} />}
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Loading />
      ) : !list.data?.items.length ? (
        <EmptyState title="No employees found" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead className="border-b border-line bg-canvas/60">
              <tr>
                {["ID", "Name", "Branch", "Department", "Designation", "Manager", "Status", "Joined", ...(canAdd ? [""] : [])].map((h, i) => <th key={h || i} className="table-head">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data.items.map((e) => (
                <tr key={e.id}>
                  <td className="table-cell font-mono text-xs">{e.employee_code}</td>
                  <td className="table-cell"><div className="font-medium">{e.full_name}</div><div className="text-xs text-ink-muted">{e.email}</div></td>
                  <td className="table-cell">{e.branch_name}</td>
                  <td className="table-cell">{e.department_name}</td>
                  <td className="table-cell text-ink-muted">{e.designation_name ?? "—"}</td>
                  <td className="table-cell text-ink-muted">{e.reporting_manager_name ?? "—"}</td>
                  <td className="table-cell">
                    <span className="chip bg-canvas capitalize text-ink-muted">{e.status}</span>
                    {e.account_status !== "active" && <span className="chip ml-1 bg-amber-50 capitalize text-amber-800">{e.account_status}</span>}
                  </td>
                  <td className="table-cell text-ink-muted">{formatDate(e.joining_date)}</td>
                  {canAdd && (
                    <td className="table-cell text-right">
                      <button className="btn-secondary whitespace-nowrap text-xs" onClick={() => setResetting(e)}>Reset access</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AddEmployee({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const branches = useApi<{ items: Opt[] }>("/branches");
  const departments = useApi<{ items: Opt[] }>("/departments");
  const designations = useApi<{ items: Opt[] }>("/designations");
  const roles = useApi<{ items: Role[] }>("/roles");
  const managers = useApi<{ items: Emp[] }>("/employees?limit=100");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ url: string; mode: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ inviteUrl: string | null; mailMode: string }>("/employees", {
        body: {
          fullName: f.get("fullName"),
          email: f.get("email"),
          phone: f.get("phone") || undefined,
          branchId: f.get("branchId"),
          departmentId: f.get("departmentId"),
          designationId: f.get("designationId") || undefined,
          reportingManagerId: f.get("reportingManagerId") || undefined,
          employmentType: f.get("employmentType"),
          joiningDate: f.get("joiningDate"),
          roleKeys: f.getAll("roleKeys"),
        },
      });
      await onSaved();
      if (r.inviteUrl) setInvite({ url: r.inviteUrl, mode: r.mailMode });
      else onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create employee");
    } finally {
      setBusy(false);
    }
  }

  if (invite) {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4" role="dialog" aria-modal>
        <div className="card mt-16 w-full max-w-lg space-y-3 p-6">
          <h2 className="text-lg font-semibold">Employee created</h2>
          <p className="text-sm text-ink-muted">
            {invite.mode === "smtp"
              ? "An invitation email has been sent."
              : "Email delivery is in TEST MODE, so no email was sent. Share this one-time link with the employee securely; it expires in 72 hours."}
          </p>
          <input readOnly className="input font-mono text-xs" value={invite.url} onFocus={(e) => e.target.select()} />
          <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>Done</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4" role="dialog" aria-modal aria-labelledby="add-emp">
      <form onSubmit={submit} className="card mt-10 w-full max-w-2xl space-y-4 p-6 shadow-xl">
        <h2 id="add-emp" className="text-lg font-semibold">Add employee</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name"><input name="fullName" required className="input" /></Field>
          <Field label="Work email"><input name="email" type="email" required className="input" /></Field>
          <Field label="Phone"><input name="phone" className="input" placeholder="+91 …" /></Field>
          <Field label="Joining date"><input name="joiningDate" type="date" required className="input" /></Field>
          <Field label="Branch">
            <select name="branchId" required className="input">{branches.data?.items.filter((b) => b.active !== false).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </Field>
          <Field label="Department">
            <select name="departmentId" required className="input">{departments.data?.items.filter((d) => d.active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          </Field>
          <Field label="Designation">
            <select name="designationId" className="input"><option value="">—</option>{designations.data?.items.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          </Field>
          <Field label="Reporting manager">
            <select name="reportingManagerId" className="input"><option value="">—</option>{managers.data?.items.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select>
          </Field>
          <Field label="Employment type">
            <select name="employmentType" className="input">{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</select>
          </Field>
        </div>
        <fieldset>
          <legend className="label">Roles</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {roles.data?.items.filter((r) => r.audience === "staff" && r.key !== "employee_base").map((r) => (
              <label key={r.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="roleKeys" value={r.key} defaultChecked={r.key === "employee"} /> {r.name}
                {r.mfa_required && <span className="chip bg-amber-50 text-amber-800">privileged</span>}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? "Creating…" : "Create and invite"}</button>
        </div>
      </form>
    </div>
  );
}

function ResetAccess({ emp, onClose }: { emp: Emp; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; mode: string } | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ resetUrl: string; mailMode: string }>(`/employees/${emp.id}/reset-access`, { method: "POST" });
      setLink({ url: r.resetUrl, mode: r.mailMode });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset access");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4" role="dialog" aria-modal aria-labelledby="reset-access">
      <div className="card mt-16 w-full max-w-lg space-y-3 p-6">
        <h2 id="reset-access" className="text-lg font-semibold">Reset access for {emp.full_name}</h2>
        {link ? (
          <>
            <p className="text-sm text-ink-muted">
              {link.mode === "smtp"
                ? "A reset email has been sent."
                : "Email delivery is in TEST MODE, so no email was sent. Share this one-time link with the employee securely; it expires in 24 hours."}
            </p>
            <input readOnly aria-label="Reset link" className="input font-mono text-xs" value={link.url} onFocus={(e) => e.target.select()} />
            <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-muted">
              This signs {emp.full_name} out everywhere, turns off their two-factor sign-in, and gives you a new one-time link to choose a password. Use it when someone forgot their password, lost their phone, or their invitation expired.
            </p>
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={confirm} disabled={busy}>{busy ? "Resetting…" : "Reset access"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

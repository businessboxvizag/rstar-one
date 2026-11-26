"use client";

import QRCode from "qrcode";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PageHeader, formatDate, useApi } from "@/components/ui";

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Your account security. Organisation settings arrive with the admin console." />
      <div className="grid gap-6 lg:grid-cols-2">
        <ChangePassword />
        <TwoFactor />
        <Sessions />
      </div>
    </>
  );
}

function ChangePassword() {
  const { reload } = useAuth();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get("newPassword") !== f.get("confirm")) return setMsg({ ok: false, text: "The new passwords do not match" });
    try {
      await api("/auth/password", { body: { currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword") } });
      form.reset();
      setMsg({ ok: true, text: "Password changed. Other devices were signed out." });
      await reload();
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors?.newPassword?.[0] : null;
      setMsg({ ok: false, text: details ?? (err instanceof Error ? err.message : "Could not change password") });
    }
  }
  return (
    <form onSubmit={submit} className="card space-y-3 p-5">
      <h2 className="font-semibold">Change password</h2>
      <input name="currentPassword" type="password" autoComplete="current-password" required placeholder="Current password" aria-label="Current password" className="input" />
      <input name="newPassword" type="password" autoComplete="new-password" required minLength={10} placeholder="New password (10+ characters, letters and numbers)" aria-label="New password" className="input" />
      <input name="confirm" type="password" autoComplete="new-password" required placeholder="Confirm new password" aria-label="Confirm new password" className="input" />
      {msg && <p role="status" className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}
      <button className="btn-primary">Update password</button>
    </form>
  );
}

function TwoFactor() {
  const { me, reload } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  if (me?.security.mfaEnabled) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold">Two-factor authentication</h2>
        <p className="mt-2 text-sm text-emerald-700">Enabled. You will be asked for a code from your authenticator app when you sign in.</p>
      </section>
    );
  }
  async function start() {
    const r = await api<{ secret: string; otpauthUrl: string }>("/auth/mfa/setup", { method: "POST" });
    setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 180 }) });
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/auth/mfa/confirm", { body: { totp: code } });
      setSetup(null);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not verify the code");
    }
  }
  return (
    <section className="card space-y-3 p-5">
      <h2 className="font-semibold">Two-factor authentication</h2>
      <p className="text-sm text-ink-muted">{me?.security.mfaRequired ? "Required for your role." : "Recommended."} Use Google Authenticator, Microsoft Authenticator or any TOTP app.</p>
      {!setup ? (
        <button className="btn-primary" onClick={() => void start()}>Set up</button>
      ) : (
        <form onSubmit={confirm} className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded border border-line" />
          <p className="text-xs text-ink-muted">Can't scan? Enter this key: <code className="break-all font-mono">{setup.secret}</code></p>
          <input inputMode="numeric" maxLength={6} aria-label="6-digit code" placeholder="6-digit code" className="input max-w-[160px] tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
          <button className="btn-primary" disabled={code.length !== 6}>Verify and enable</button>
        </form>
      )}
    </section>
  );
}

function Sessions() {
  const s = useApi<{ items: { id: string; user_agent: string | null; ip: string | null; last_used_at: string; current: boolean }[] }>("/me/sessions");
  return (
    <section className="card p-5 lg:col-span-2">
      <h2 className="mb-3 font-semibold">Signed-in devices</h2>
      <ul className="divide-y divide-line">
        {s.data?.items.map((x) => (
          <li key={x.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <div className="truncate">{x.user_agent ?? "Unknown device"}</div>
              <div className="text-xs text-ink-muted">{x.ip ?? ""} · last used {formatDate(x.last_used_at, true)}</div>
            </div>
            {x.current ? (
              <span className="chip bg-emerald-50 text-emerald-800">This device</span>
            ) : (
              <button className="btn-danger" onClick={async () => { await api(`/me/sessions/${x.id}`, { method: "DELETE" }); await s.reload(); }}>Sign out</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

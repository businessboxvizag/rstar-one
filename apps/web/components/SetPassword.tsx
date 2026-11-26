"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PARTNER_SIGNATURE, PasswordPolicy } from "@rstar/shared";
import { api, ApiError } from "@/lib/api";

/** Shared page for invitation links (/accept-invite) and password reset links (/reset-password). */
export function SetPassword({ mode }: { mode: "invite" | "reset" }) {
  const token = useSearchParams().get("token") ?? "";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const ok = PasswordPolicy.safeParse(pw);
    if (!ok.success) return setError(ok.error.issues[0]?.message ?? "Choose a stronger password");
    if (pw !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    try {
      await api(mode === "invite" ? "/auth/invite/accept" : "/auth/password-reset/confirm", { method: "POST", body: { token, newPassword: pw } }, false);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-b from-white to-canvas">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <Image src="/rstar-tv-logo.png" alt="RSTAR TV" width={96} height={96} priority />
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">RSTAR <span className="text-rstar">ONE</span></h1>
            <p className="mt-1 text-sm text-ink-muted">{mode === "invite" ? "Welcome! Choose a password to activate your account." : "Choose a new password."}</p>
          </div>
          {!token ? (
            <div className="card p-6 text-sm">This link is incomplete. Please open the full link you were sent, or ask HR for a new one.</div>
          ) : done ? (
            <div className="card space-y-4 p-6 text-sm">
              <p>{mode === "invite" ? "Your account is ready." : "Your password has been changed."} Sign in with your work email and the password you just chose.</p>
              <Link href="/login" className="btn-primary w-full">Go to sign in</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="card space-y-4 p-6 shadow-sm" noValidate>
              <div>
                <label htmlFor="pw" className="label">New password</label>
                <input id="pw" type="password" autoComplete="new-password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} />
                <p className="mt-1 text-xs text-ink-faint">At least 10 characters, with letters and numbers.</p>
              </div>
              <div>
                <label htmlFor="pw2" className="label">Confirm password</label>
                <input id="pw2" type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              <button className="btn-primary w-full" disabled={busy}>{busy ? "Saving…" : mode === "invite" ? "Activate account" : "Change password"}</button>
            </form>
          )}
        </div>
      </div>
      <footer className="pb-6 text-center text-xs text-ink-faint"><span className="text-bbox">{PARTNER_SIGNATURE}</span></footer>
    </main>
  );
}

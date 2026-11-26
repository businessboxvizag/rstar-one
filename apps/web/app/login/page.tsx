"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PARTNER_SIGNATURE } from "@rstar/shared";
import { ApiError, login } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, needTotp ? totp : undefined);
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_required") {
        setNeedTotp(true);
      } else {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-b from-white to-canvas">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <Image src="/rstar-tv-logo.png" alt="RSTAR TV" width={96} height={96} priority />
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">
              RSTAR <span className="text-rstar">ONE</span>
            </h1>
            <p className="mt-1 text-sm text-ink-muted">Sign in to your workspace</p>
          </div>
          <form onSubmit={submit} className="card space-y-4 p-6 shadow-sm" noValidate>
            <div>
              <label htmlFor="email" className="label">Work email</label>
              <input id="email" type="email" autoComplete="username" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label htmlFor="password" className="label">Password</label>
              <input id="password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {needTotp && (
              <div>
                <label htmlFor="totp" className="label">6-digit code from your authenticator app</label>
                <input id="totp" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" autoFocus className="input tracking-widest" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />
              </div>
            )}
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={busy || !email || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="text-center text-xs text-ink-faint">Forgot your password? Ask HR to reset your access.</p>
          </form>
        </div>
      </div>
      <footer className="pb-6 text-center text-xs text-ink-faint">
        <span className="text-bbox">{PARTNER_SIGNATURE}</span>
      </footer>
    </main>
  );
}

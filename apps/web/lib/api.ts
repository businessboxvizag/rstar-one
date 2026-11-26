"use client";

/**
 * Browser API client.
 * - The access token lives only in memory.
 * - The refresh token lives in an httpOnly cookie set by our own Next.js route
 *   handlers (/api/session), so page scripts can never read it.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function setAccessToken(t: string | null) {
  accessToken = t;
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch("/api/session/refresh", { method: "POST" });
      if (!r.ok) return false;
      const j = (await r.json()) as { accessToken: string };
      accessToken = j.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  if (!accessToken && retry) await refreshSession();
  const res = await fetch(`${API}/v1${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401 && retry && (await refreshSession())) return api<T>(path, init, false);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json as T;
}

export async function login(email: string, password: string, totp?: string) {
  const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, totp }) });
  const j = await r.json();
  if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "error", j?.error?.message ?? "Sign-in failed");
  accessToken = j.accessToken;
}

export async function logout() {
  try {
    if (accessToken) await api("/auth/logout", { method: "POST" }, false);
  } catch {
    /* session may already be gone */
  }
  accessToken = null;
  await fetch("/api/session", { method: "DELETE" });
}

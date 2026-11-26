import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

/**
 * Mobile API client. The refresh token is kept in the OS keychain/keystore
 * (expo-secure-store); the access token only in memory.
 */
const API: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "http://localhost:4000";
const RT_KEY = "rstar.refreshToken";
let accessToken: string | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function raw<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const res = await fetch(`${API}/v1${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(init.auth !== false && accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

export async function restoreSession(): Promise<boolean> {
  const rt = await SecureStore.getItemAsync(RT_KEY);
  if (!rt) return false;
  try {
    const r = await raw<{ accessToken: string; refreshToken: string | null }>("/auth/refresh", { body: { refreshToken: rt }, auth: false });
    accessToken = r.accessToken;
    if (r.refreshToken) await SecureStore.setItemAsync(RT_KEY, r.refreshToken);
    return true;
  } catch {
    await SecureStore.deleteItemAsync(RT_KEY);
    return false;
  }
}

export async function login(email: string, password: string, totp?: string) {
  const r = await raw<{ accessToken: string; refreshToken: string }>("/auth/login", { body: { email, password, totp }, auth: false });
  accessToken = r.accessToken;
  await SecureStore.setItemAsync(RT_KEY, r.refreshToken);
}

export async function logout() {
  try {
    await raw("/auth/logout", { method: "POST" });
  } catch {
    /* already signed out */
  }
  accessToken = null;
  await SecureStore.deleteItemAsync(RT_KEY);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await raw<T>(path, init);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await restoreSession())) return raw<T>(path, init);
    throw e;
  }
}

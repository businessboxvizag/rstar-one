export const SESSION_COOKIE = "rstar_rt";
export const API_INTERNAL = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Refresh-token cookie: httpOnly, same-site strict, only sent to our own /api/session routes. */
export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/api/session",
    maxAge: maxAgeSeconds,
  };
}

import { NextResponse, type NextRequest } from "next/server";
import { API_INTERNAL, SESSION_COOKIE, cookieOptions } from "@/lib/session-cookie";

/** Sign in: forwards credentials to the API and keeps the refresh token in an httpOnly cookie. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const r = await fetch(`${API_INTERNAL}/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "",
      "user-agent": req.headers.get("user-agent") ?? "",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) return NextResponse.json(j, { status: r.status });
  const res = NextResponse.json({ accessToken: j.accessToken, expiresIn: j.expiresIn });
  res.cookies.set(SESSION_COOKIE, j.refreshToken, cookieOptions(60 * 60 * 24 * 30));
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}

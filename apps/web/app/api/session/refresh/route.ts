import { NextResponse, type NextRequest } from "next/server";
import { API_INTERNAL, SESSION_COOKIE, cookieOptions } from "@/lib/session-cookie";

/** Exchanges the httpOnly refresh cookie for a new access token (and rotates the cookie). */
export async function POST(req: NextRequest) {
  const rt = req.cookies.get(SESSION_COOKIE)?.value;
  if (!rt) return NextResponse.json({ error: { code: "unauthorized", message: "Not signed in" } }, { status: 401 });
  const r = await fetch(`${API_INTERNAL}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: rt }),
  });
  const j = await r.json();
  if (!r.ok) {
    const res = NextResponse.json(j, { status: r.status });
    res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
    return res;
  }
  const res = NextResponse.json({ accessToken: j.accessToken, expiresIn: j.expiresIn });
  res.cookies.set(SESSION_COOKIE, j.refreshToken, cookieOptions(60 * 60 * 24 * 30));
  return res;
}

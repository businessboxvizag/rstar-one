import type { FastifyInstance } from "fastify";
import { randomToken, sha256 } from "../../lib/crypto.js";
import type { Queryable } from "../../db.js";

export async function createSession(app: FastifyInstance, userId: string, orgId: string, meta: { ip: string; userAgent: string | null }) {
  const refreshToken = randomToken(32);
  const days = app.config.REFRESH_TOKEN_TTL_DAYS;
  const s = await app.db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, refresh_token_hash, mfa_verified, user_agent, ip, expires_at)
     VALUES ($1,$2,true,$3,$4, now() + make_interval(days => $5)) RETURNING id`,
    [userId, sha256(refreshToken), meta.userAgent?.slice(0, 400) ?? null, meta.ip, days],
  );
  const sid = s.rows[0]!.id;
  const accessToken = await app.tokens.sign({ sub: userId, sid, org: orgId });
  return { accessToken, refreshToken, expiresIn: app.config.ACCESS_TOKEN_TTL_SECONDS, sessionId: sid };
}

/** Issues a one-time token (invite or password reset). Only the hash is stored. */
export async function issueOneTimeToken(q: Queryable, userId: string, purpose: "invite" | "password_reset", hours: number) {
  const token = randomToken(32);
  await q.query(
    `UPDATE one_time_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  await q.query(
    `INSERT INTO one_time_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))`,
    [userId, purpose, sha256(token), hours],
  );
  return token;
}

export async function consumeOneTimeToken(q: Queryable, token: string, purpose: "invite" | "password_reset") {
  const r = await q.query<{ user_id: string }>(
    `UPDATE one_time_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(token), purpose],
  );
  return r.rows[0]?.user_id ?? null;
}

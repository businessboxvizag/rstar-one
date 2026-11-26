import { SignJWT, jwtVerify } from "jose";

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  org: string;
}

const ISSUER = "rstar-one";
const AUDIENCE = "rstar-one-api";

export class TokenService {
  private key: Uint8Array;
  constructor(secret: string, private ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(c: AccessClaims): Promise<string> {
    return new SignJWT({ sid: c.sid, org: c.org })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(c.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.org !== "string") return null;
      return { sub: payload.sub, sid: payload.sid, org: payload.org };
    } catch {
      return null;
    }
  }
}

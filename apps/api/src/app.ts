import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError, type ZodTypeAny, type z } from "zod";
import type { Config } from "./config.js";
import { createPool, type Db } from "./db.js";
import { HttpError, unauthorized } from "./errors.js";
import { TokenService } from "./auth/tokens.js";
import { loadPrincipal, type Principal } from "./auth/principal.js";
import { createMailer, type Mailer } from "./lib/mailer.js";
import { authRoutes } from "./modules/auth/routes.js";
import { orgRoutes } from "./modules/org/routes.js";
import { taskRoutes } from "./modules/tasks/routes.js";
import { roleRoutes } from "./modules/roles/routes.js";
import { employeeRoutes } from "./modules/employees/routes.js";
import { contentRoutes } from "./modules/content/routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { attendanceRoutes } from "./modules/attendance/routes.js";
import { leaveRoutes } from "./modules/leave/routes.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    tokens: TokenService;
    mailer: Mailer;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    principal: Principal;
  }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

/** Request metadata for audit events. */
export function reqMeta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers["user-agent"] ?? null, requestId: req.id };
}

export async function buildApp(config: Config, opts: { db?: Db; logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024, // JSON only; media never passes through the API (signed URLs)
  });

  // Browsers and some clients send "content-type: application/json" on action POSTs with no body
  // (e.g. "Set up 2FA"). Fastify rejects that by default; treat an empty JSON body as {}.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400 }), undefined);
    }
  });

  app.decorate("config", config);
  app.decorate("db", opts.db ?? createPool(config.DATABASE_URL));
  app.decorate("tokens", new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS));
  app.decorate("mailer", createMailer(config, app.log));
  app.decorateRequest("principal", null as unknown as Principal);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()),
    credentials: false,
    // @fastify/cors only allows GET/HEAD/POST by default; the web app also uses PUT, PATCH and DELETE.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });

  app.decorate("authenticate", async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw unauthorized();
    const claims = await app.tokens.verify(h.slice(7));
    if (!claims) throw unauthorized("Session expired");
    const s = await app.db.query("SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()", [
      claims.sid,
      claims.sub,
    ]);
    if (!s.rowCount) throw unauthorized("Session revoked");
    const p = await loadPrincipal(app.db, claims.sub, claims.sid, { mfaEnforcement: config.MFA_ENFORCEMENT === "on" });
    if (!p) throw unauthorized("Account is not active");
    req.principal = p;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "validation_failed", message: "Invalid input", details: err.flatten() } });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: (err as { code?: string }).code ?? "error", message: err.message } });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") return reply.status(409).send({ error: { code: "conflict", message: "A record with these details already exists" } });
    if (pgCode === "23503") return reply.status(400).send({ error: { code: "bad_reference", message: "A referenced record does not exist" } });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong", requestId: req.id } });
  });

  app.get("/health", async () => {
    await app.db.query("SELECT 1");
    return { status: "ok" };
  });

  await app.register(authRoutes, { prefix: "/v1" });
  await app.register(orgRoutes, { prefix: "/v1" });
  await app.register(roleRoutes, { prefix: "/v1" });
  await app.register(employeeRoutes, { prefix: "/v1" });
  await app.register(contentRoutes, { prefix: "/v1" });
  await app.register(auditRoutes, { prefix: "/v1" });
  await app.register(notificationRoutes, { prefix: "/v1" });
  await app.register(attendanceRoutes, { prefix: "/v1" });
  await app.register(leaveRoutes, { prefix: "/v1" });
  await app.register(taskRoutes, { prefix: "/v1" });

  app.addHook("onClose", async () => {
    if (!opts.db) await app.db.end();
  });
  return app;
}

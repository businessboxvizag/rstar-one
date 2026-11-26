import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, type Db } from "../src/db.js";
import { seed } from "../src/seed.js";
import { totpAt } from "../src/lib/crypto.js";

export const ADMIN = { email: "owner@test.local", name: "Test Owner", password: "OwnerPass123" };

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  orgId: string;
  ids: { branches: Record<string, string>; departments: Record<string, string>; clients: Record<string, string>; channels: Record<string, string> };
}

export async function setupApp(overrides: Record<string, string> = {}): Promise<TestCtx> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://rstar:rstar@localhost:5432/rstar_one_test";
  const db = createPool(url, 20);
  const { orgId } = await seed(db, { admin: ADMIN });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url,
    JWT_SECRET: "test-secret-test-secret-test-secret-0123456789",
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MFA_ENFORCEMENT: "off",
    MAIL_TRANSPORT: "memory",
    LOG_LEVEL: process.env.TEST_LOGS === "1" ? "error" : "silent",
    LOGIN_RATE_LIMIT_PER_MINUTE: "1000",
    ...overrides,
  });
  const app = await buildApp(config, { db, logger: process.env.TEST_LOGS === "1" });
  const q = async (sql: string) => Object.fromEntries((await db.query(sql, [orgId])).rows.map((r) => [r.k, r.id]));
  const ids = {
    branches: await q("SELECT code AS k, id FROM branches WHERE organisation_id = $1"),
    departments: await q("SELECT code AS k, id FROM departments WHERE organisation_id = $1"),
    clients: await q("SELECT name AS k, id FROM clients WHERE organisation_id = $1"),
    channels: await q("SELECT name AS k, id FROM channels WHERE organisation_id = $1"),
  };
  return { app, db, orgId, ids };
}

export async function teardown(ctx: TestCtx) {
  await ctx.app.close();
  await ctx.db.end();
}

export async function login(app: FastifyInstance, email: string, password: string, totp?: string) {
  const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password, totp } });
  if (r.statusCode !== 200) throw new Error(`login failed for ${email}: ${r.statusCode} ${r.body}`);
  return r.json() as { accessToken: string; refreshToken: string };
}

export function client(app: FastifyInstance, token: string) {
  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE") => (url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${token}` } });
  return { get: call("GET"), post: call("POST"), patch: call("PATCH"), put: call("PUT"), del: call("DELETE") };
}

export type Api = ReturnType<typeof client>;

let counter = 0;
/** Creates an employee through the real API (as the admin) and logs them in. */
export async function makeEmployee(
  ctx: TestCtx,
  admin: Api,
  opts: { roles: string[]; branch?: string; dept?: string; managerId?: string; name?: string },
) {
  counter += 1;
  const email = `user${counter}.${Date.now()}@test.local`;
  const password = "Passw0rd!x" + counter;
  const r = await admin.post("/v1/employees", {
    fullName: opts.name ?? `Test User ${counter}`,
    email,
    branchId: ctx.ids.branches[opts.branch ?? "VZG"],
    departmentId: ctx.ids.departments[opts.dept ?? "EDIT"],
    reportingManagerId: opts.managerId,
    joiningDate: "2026-01-05",
    roleKeys: opts.roles,
    initialPassword: password,
  });
  if (r.statusCode !== 201) throw new Error(`create employee failed: ${r.statusCode} ${r.body}`);
  const emp = r.json();
  const tokens = await login(ctx.app, email, password);
  return { emp, email, password, api: client(ctx.app, tokens.accessToken), userId: emp.user_id as string };
}

export async function adminApi(ctx: TestCtx) {
  const t = await login(ctx.app, ADMIN.email, ADMIN.password);
  return client(ctx.app, t.accessToken);
}

export const totpNow = (secret: string) => totpAt(secret, Date.now());

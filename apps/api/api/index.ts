import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Vercel serverless entry: one Fastify instance per warm function.
 * Use a pooled Postgres connection string (e.g. Neon "-pooler" host) for DATABASE_URL.
 */
const ready = (async () => {
  const app = await buildApp(loadConfig());
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit("request", req, res);
}

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./lib/crypto.js";
import type { Db } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and dist/src/ (compiled).
export const MIGRATIONS_DIR = here.includes(`${"dist"}`) ? join(here, "../../migrations") : join(here, "../migrations");

/**
 * Forward-only SQL migrations. Each file runs in its own transaction; applied
 * files are recorded with a checksum and editing an applied file is an error.
 * An advisory lock prevents two deploys migrating at once.
 */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7351001)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const ran: string[] = [];
    for (const f of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, f), "utf8");
      const sum = sha256(sql);
      const prev = applied.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`Migration ${f} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${f}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)", [f, sum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      ran.push(f);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7351001)").catch(() => {});
    client.release();
  }
}

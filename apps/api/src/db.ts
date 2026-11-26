import pg from "pg";

// bigint → number (all our bigints are well under 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query">;

export function createPool(url: string, max = 10): Db {
  return new pg.Pool({ connectionString: url, max });
}

/** Run fn in a transaction. Serialization failures / deadlocks are retried a few times. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      if ((code === "40001" || code === "40P01") && attempt < 4) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

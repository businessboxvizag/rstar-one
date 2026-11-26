import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";

/** Rebuilds the test database from migrations once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://rstar:rstar@localhost:5432/rstar_one_test";
  if (!/test/.test(url)) throw new Error(`Refusing to reset a database whose name does not contain "test": ${url}`);
  process.env.TEST_DATABASE_URL = url;
  const db = createPool(url, 1);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  await db.end();
}

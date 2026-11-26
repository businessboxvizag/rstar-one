import { createPool } from "../db.js";
import { migrate } from "../migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const db = createPool(url, 1);
try {
  const ran = await migrate(db, (m) => console.log(m));
  console.log(ran.length ? `applied ${ran.length} migration(s)` : "database is up to date");
} finally {
  await db.end();
}

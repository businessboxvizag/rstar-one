import { PasswordPolicy } from "@rstar/shared";
import { createPool } from "../db.js";
import { seed } from "../seed.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD ?? "";
const name = process.env.SEED_ADMIN_NAME ?? "Owner";

let admin: { email: string; name: string; password: string } | undefined;
if (email) {
  const ok = PasswordPolicy.safeParse(password);
  if (!ok.success) {
    console.error("SEED_ADMIN_PASSWORD must be at least 10 characters with letters and numbers.");
    process.exit(1);
  }
  admin = { email, name, password };
}

if (process.env.NODE_ENV === "production" && process.env.SEED_DEMO_DATA === "true") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const db = createPool(url, 1);
try {
  const r = await seed(db, { admin, log: (m) => console.log(m) });
  console.log(`seed complete for organisation ${r.orgId}`);
} finally {
  await db.end();
}

import { DEFAULT_ROLES, EMPLOYEE_BASE } from "@rstar/shared";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { hashPassword } from "./lib/crypto.js";

/**
 * Idempotent organisation seed: structure, roles, channels, clients and Content ID
 * prefixes. Safe to re-run; existing rows (and any admin edits to them) are kept.
 * Prefixes follow the project brief: CarCart CC, RSTAR News RN, Pulse Hospital PH, Avakai AV.
 */
export const SEED = {
  organisation: { legalName: "BusinessBOX / Stanley Enterprises", productName: "RSTAR ONE" },
  branches: [
    { code: "VZG", name: "Visakhapatnam", city: "Visakhapatnam" },
    { code: "HYD", name: "Hyderabad", city: "Hyderabad" },
  ],
  departments: [
    { code: "MGMT", name: "Management" },
    { code: "EDIT", name: "Video Editing" },
    { code: "CAMERA", name: "Camera & Production" },
    { code: "SCRIPT", name: "Scripting & Content" },
    { code: "SOCIAL", name: "Social Media & Posting" },
    { code: "SALES", name: "Sales & Marketing" },
    { code: "ADMIN_HR", name: "Administration / HR" },
    { code: "IT", name: "Web Development / IT" },
  ],
  designations: ["Managing Director", "Branch Manager", "Video Editor", "Senior Video Editor", "Cameraman", "Camera & Editor", "Script Writer", "Social Media Executive", "Sales Executive", "HR Executive", "Accountant", "Web Developer"],
  channels: [
    { name: "RSTAR News", prefix: "RN" },
    { name: "RSTAR Health", prefix: "RH" },
    { name: "RSTAR Bhakthi", prefix: "RB" },
    { name: "RSTAR Entertainment", prefix: "RE" },
    { name: "RSTAR Opinions", prefix: "RO" },
  ],
  clients: [
    { name: "CarCart", prefix: "CC", industry: "Automotive" },
    { name: "Avakai", prefix: "AV", industry: "Food" },
    { name: "Avakai.com", prefix: "AVC", industry: "E-commerce" },
    { name: "Pulse Hospital", prefix: "PH", industry: "Healthcare" },
  ],
} as const;

export interface SeedOptions {
  admin?: { email: string; name: string; password: string };
  log?: (m: string) => void;
}

export async function seed(db: Db, opts: SeedOptions = {}) {
  const log = opts.log ?? (() => {});
  return withTx(db, async (tx) => {
    let org = (await tx.query("SELECT id FROM organisations ORDER BY created_at LIMIT 1")).rows[0];
    if (!org) {
      org = (await tx.query("INSERT INTO organisations (legal_name, product_name) VALUES ($1,$2) RETURNING id", [SEED.organisation.legalName, SEED.organisation.productName])).rows[0];
      log("created organisation");
    }
    const orgId: string = org.id;

    for (const b of SEED.branches) {
      await tx.query("INSERT INTO branches (organisation_id, code, name, city) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [orgId, b.code, b.name, b.city]);
    }
    for (const d of SEED.departments) {
      await tx.query("INSERT INTO departments (organisation_id, code, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [orgId, d.code, d.name]);
    }
    for (const n of SEED.designations) {
      await tx.query("INSERT INTO designations (organisation_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [orgId, n]);
    }

    // Roles: grants are written only when the role is first created, so admin edits survive re-seeding.
    const roles = [
      { key: "employee_base", name: "Every employee (base)", description: "Self-service permissions every staff member receives automatically.", mfaRequired: false, audience: "staff" as const, grants: EMPLOYEE_BASE },
      ...DEFAULT_ROLES,
    ];
    for (const r of roles) {
      const ins = await tx.query(
        `INSERT INTO roles (organisation_id, key, name, description, audience, mfa_required, is_system)
         VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (organisation_id, key) DO NOTHING RETURNING id`,
        [orgId, r.key, r.name, r.description, r.audience, r.mfaRequired],
      );
      const id = ins.rows[0]?.id;
      if (!id) continue;
      for (const [k, s] of Object.entries(r.grants)) {
        await tx.query("INSERT INTO role_permissions (role_id, permission_key, scope) VALUES ($1,$2,$3)", [id, k, s]);
      }
    }

    for (const c of SEED.channels) {
      const ch = (await tx.query("INSERT INTO channels (organisation_id, name) VALUES ($1,$2) ON CONFLICT (organisation_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [orgId, c.name])).rows[0];
      await tx.query("INSERT INTO content_sequences (organisation_id, channel_id, prefix) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [orgId, ch.id, c.prefix]);
    }
    for (const c of SEED.clients) {
      const cl = (await tx.query("INSERT INTO clients (organisation_id, name, industry) VALUES ($1,$2,$3) ON CONFLICT (organisation_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [orgId, c.name, c.industry])).rows[0];
      await tx.query("INSERT INTO content_sequences (organisation_id, client_id, prefix) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [orgId, cl.id, c.prefix]);
    }

    let adminUserId: string | null = null;
    if (opts.admin) {
      const existing = (await tx.query("SELECT id FROM users WHERE organisation_id = $1 AND email = $2", [orgId, opts.admin.email])).rows[0];
      if (existing) {
        adminUserId = existing.id;
      } else {
        const u = (
          await tx.query(
            `INSERT INTO users (organisation_id, kind, email, display_name, password_hash, must_change_password, status)
             VALUES ($1,'staff',$2,$3,$4,true,'active') RETURNING id`,
            [orgId, opts.admin.email, opts.admin.name, await hashPassword(opts.admin.password)],
          )
        ).rows[0];
        adminUserId = u.id;
        await tx.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE organisation_id = $2 AND key = 'super_admin'", [u.id, orgId]);
        await tx.query(
          `INSERT INTO employees (organisation_id, user_id, employee_code, full_name, email, branch_id, department_id, joining_date, status)
           SELECT $1, $2, 'RS0000', $3, $4, b.id, d.id, current_date, 'active'
             FROM branches b, departments d WHERE b.organisation_id = $1 AND b.code = 'VZG' AND d.organisation_id = $1 AND d.code = 'MGMT'`,
          [orgId, u.id, opts.admin.name, opts.admin.email],
        );
        log(`created Super Admin ${opts.admin.email} (must change password at first login)`);
      }
    }
    return { orgId, adminUserId };
  });
}

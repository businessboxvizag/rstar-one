/**
 * RSTAR ONE permission catalogue and default role matrix.
 *
 * This file is the single source of truth for permission keys and the
 * default (seeded) role grants. The API enforces these server-side; the web
 * and mobile apps only use them to decide what to *show*. Custom roles are
 * stored in the database and may grant any key below at any scope.
 *
 * docs/permission-matrix.md is generated from this file
 * (pnpm --filter @rstar/shared run docs:permissions).
 */

/** Data scopes, narrowest first. A grant at a wider scope implies the narrower ones. */
export const SCOPES = ["own", "team", "department", "branch", "org"] as const;
export type Scope = (typeof SCOPES)[number];

export function scopeRank(scope: Scope): number {
  return SCOPES.indexOf(scope);
}

export function widerScope(a: Scope | null, b: Scope | null): Scope | null {
  if (a === null) return b;
  if (b === null) return a;
  return scopeRank(a) >= scopeRank(b) ? a : b;
}

export interface PermissionDef {
  key: string;
  module: string;
  description: string;
  /** Sensitive permissions are highlighted in the matrix and always audited. */
  sensitive?: boolean;
}

const p = (key: string, module: string, description: string, sensitive = false): PermissionDef => ({
  key,
  module,
  description,
  sensitive,
});

export const PERMISSIONS = [
  // Organisation & access
  p("org.settings.manage", "Organisation", "Change organisation profile, product name and branding", true),
  p("org.structure.manage", "Organisation", "Create/rename/deactivate branches, departments, teams, designations", true),
  p("roles.manage", "Organisation", "Create custom roles and change role permissions", true),
  p("users.manage", "Organisation", "Create accounts, assign roles, reset access, deactivate users", true),
  p("audit.read", "Organisation", "Read the audit log", true),
  p("channels.manage", "Organisation", "Configure channels, clients' content prefixes and ID sequences"),
  // HRMS
  p("employees.read", "HRMS", "View employee profiles (non-sensitive fields)"),
  p("employees.manage", "HRMS", "Create/edit employees, transfers, probation, exits"),
  p("employees.sensitive.read", "HRMS", "View bank, salary and identity document details", true),
  // Attendance
  p("attendance.self", "Attendance", "Check in/out and request corrections for oneself"),
  p("attendance.read", "Attendance", "View attendance records"),
  p("attendance.approve", "Attendance", "Approve corrections, exceptions and manual attendance", true),
  p("attendance.configure", "Attendance", "Configure geofences, shifts, late/early rules", true),
  // Leave
  p("leave.self", "Leave", "Apply for, cancel and view own leave"),
  p("leave.read", "Leave", "View leave requests and balances"),
  p("leave.approve", "Leave", "Approve or reject leave requests"),
  p("leave.configure", "Leave", "Configure leave types, accrual and carry-forward", true),
  // Payroll
  p("payroll.self", "Payroll", "View and download own payslips"),
  p("payroll.read", "Payroll", "View payroll runs and salary data", true),
  p("payroll.process", "Payroll", "Prepare payroll drafts, adjustments, advances", true),
  p("payroll.approve", "Payroll", "Approve and lock payroll runs (separate from processing)", true),
  p("payroll.configure", "Payroll", "Configure salary components and statutory settings", true),
  // Work management
  p("projects.read", "Projects", "View projects"),
  p("projects.manage", "Projects", "Create projects and manage membership"),
  p("tasks.self", "Projects", "Work on tasks assigned to oneself"),
  p("tasks.manage", "Projects", "Create, assign and re-prioritise tasks"),
  // Media production
  p("content.read", "Production", "View content items and their history"),
  p("content.create", "Production", "Create content items (allocates a Content ID)"),
  p("content.assign", "Production", "Assign owners, reassign and escalate content"),
  p("content.cancel", "Production", "Cancel content items (ID is never reused)"),
  p("script.write", "Production", "Draft and submit scripts"),
  p("script.review", "Production", "Review scripts"),
  p("script.approve", "Production", "Approve or reject scripts"),
  p("shoot.schedule", "Production", "Schedule shoots and allocate crew/equipment"),
  p("shoot.execute", "Production", "Start/complete assigned shoots"),
  p("footage.upload", "Production", "Upload footage and register Drive links"),
  p("footage.verify", "Production", "Verify, accept or reject footage"),
  p("edit.assign", "Production", "Assign editors"),
  p("edit.work", "Production", "Work on edits and submit cuts"),
  p("review.internal", "Production", "Internal review of cuts"),
  p("review.client", "Production", "Client-side approval of scripts and cuts (portal)"),
  p("content.final_approve", "Production", "Give final approval for publishing"),
  p("publish.manage", "Social", "Schedule posts and record published URLs"),
  p("analytics.read", "Social", "View analytics snapshots and reports"),
  p("analytics.manage", "Social", "Enter/import analytics and manage platform connections"),
  // Media storage
  p("media.read", "Storage", "Browse media metadata and previews"),
  p("media.upload", "Storage", "Create upload sessions"),
  p("media.download", "Storage", "Download original media (logged)"),
  p("media.manage", "Storage", "Archive, restore, retention and deletion approvals", true),
  // CRM, sales, finance
  p("crm.read", "CRM", "View clients, contacts and deliverables"),
  p("crm.manage", "CRM", "Manage clients, contracts and contacts"),
  p("sales.read", "Sales", "View leads and pipeline"),
  p("sales.manage", "Sales", "Manage leads, proposals and quotations"),
  p("finance.read", "Finance", "View invoices, payments, expenses and reports", true),
  p("finance.manage", "Finance", "Create invoices, bills, expenses and payments", true),
  p("finance.approve", "Finance", "Approve purchases/expenses above threshold", true),
  // Administration
  p("assets.read", "Assets", "View equipment and office assets"),
  p("assets.manage", "Assets", "Manage assets, assignment, maintenance"),
  // Reports
  p("reports.read", "Reports", "View dashboards and reports"),
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((x) => x.key);

export function isPermissionKey(v: string): v is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(v);
}

export type Grants = Partial<Record<PermissionKey, Scope>>;

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  /** Privileged roles must enrol in MFA before using privileged permissions. */
  mfaRequired: boolean;
  /** "client" roles may only use the client portal. */
  audience: "staff" | "client";
  grants: Grants;
}

/** Every staff member gets these on top of their role. */
export const EMPLOYEE_BASE: Grants = {
  "employees.read": "own",
  "attendance.self": "own",
  // "team" = oneself plus one's direct reports, so a reporting manager can review their team.
  "attendance.read": "team",
  "attendance.approve": "team",
  "leave.self": "own",
  "leave.read": "team",
  "leave.approve": "team",
  "payroll.self": "own",
  "projects.read": "own",
  "tasks.self": "own",
  // Assign tasks to oneself and one's direct reports.
  "tasks.manage": "team",
  "content.read": "own",
  "media.read": "own",
  "assets.read": "own",
};

const ALL_ORG: Grants = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, "org"])) as Grants;
const { ["review.client"]: _clientOnly, ...ALL_STAFF_ORG } = ALL_ORG;

const PRODUCTION_PIPELINE_ORG: Grants = {
  "content.read": "org",
  "content.create": "org",
  "content.assign": "org",
  "content.cancel": "org",
  "script.review": "org",
  "script.approve": "org",
  "shoot.schedule": "org",
  "footage.upload": "org",
  "footage.verify": "org",
  "edit.assign": "org",
  "review.internal": "org",
  "content.final_approve": "org",
  "media.read": "org",
  "media.upload": "org",
  "media.download": "org",
  "analytics.read": "org",
  "projects.read": "org",
  "tasks.manage": "org",
};

export const DEFAULT_ROLES: readonly RoleDef[] = [
  {
    key: "super_admin",
    name: "Super Admin / Owner",
    description: "Full system configuration and emergency access.",
    mfaRequired: true,
    audience: "staff",
    grants: ALL_STAFF_ORG,
  },
  {
    key: "management",
    name: "Management",
    description: "Organisation-wide oversight and approvals. No role/system configuration.",
    mfaRequired: true,
    audience: "staff",
    grants: {
      ...PRODUCTION_PIPELINE_ORG,
      "audit.read": "org",
      "employees.read": "org",
      "employees.sensitive.read": "org",
      "attendance.read": "org",
      "attendance.approve": "org",
      "leave.read": "org",
      "leave.approve": "org",
      "payroll.read": "org",
      "payroll.approve": "org",
      "projects.manage": "org",
      "publish.manage": "org",
      "crm.read": "org",
      "crm.manage": "org",
      "sales.read": "org",
      "finance.read": "org",
      "finance.approve": "org",
      "assets.read": "org",
      "reports.read": "org",
    },
  },
  {
    key: "branch_manager",
    name: "Branch Manager",
    description: "Operational lead for one branch.",
    mfaRequired: true,
    audience: "staff",
    grants: {
      "employees.read": "branch",
      "attendance.read": "branch",
      "attendance.approve": "branch",
      "leave.read": "branch",
      "leave.approve": "branch",
      "projects.read": "branch",
      "projects.manage": "branch",
      "tasks.manage": "branch",
      "content.read": "branch",
      "content.create": "branch",
      "content.assign": "branch",
      "shoot.schedule": "branch",
      "footage.verify": "branch",
      "edit.assign": "branch",
      "media.read": "branch",
      "media.upload": "branch",
      "assets.read": "branch",
      "assets.manage": "branch",
      "reports.read": "branch",
    },
  },
  {
    key: "department_head",
    name: "Department Head",
    description: "Leads one department: team, tasks, approvals.",
    mfaRequired: false,
    audience: "staff",
    grants: {
      "employees.read": "department",
      "attendance.read": "department",
      "attendance.approve": "department",
      "leave.read": "department",
      "leave.approve": "department",
      "projects.read": "department",
      "projects.manage": "department",
      "tasks.manage": "department",
      "content.read": "department",
      "content.assign": "department",
      "review.internal": "department",
      "media.read": "department",
      "reports.read": "department",
    },
  },
  {
    key: "hr_admin",
    name: "HR Admin",
    description: "Employee records, attendance, leave and payroll processing.",
    mfaRequired: true,
    audience: "staff",
    grants: {
      "org.structure.manage": "org",
      "users.manage": "org",
      "employees.read": "org",
      "employees.manage": "org",
      "employees.sensitive.read": "org",
      "attendance.read": "org",
      "attendance.approve": "org",
      "attendance.configure": "org",
      "leave.read": "org",
      "leave.approve": "org",
      "leave.configure": "org",
      "payroll.read": "org",
      "payroll.process": "org",
      "payroll.configure": "org",
      "assets.read": "org",
      "reports.read": "org",
    },
  },
  {
    key: "finance_admin",
    name: "Finance Admin",
    description: "Invoices, bills, expenses, payments, finance reports.",
    mfaRequired: true,
    audience: "staff",
    grants: {
      "crm.read": "org",
      "finance.read": "org",
      "finance.manage": "org",
      "payroll.read": "org",
      "assets.read": "org",
      "reports.read": "org",
    },
  },
  {
    key: "project_manager",
    name: "Project Manager / Producer",
    description: "Plans content, assigns crew and editors, runs reviews.",
    mfaRequired: false,
    audience: "staff",
    grants: { ...PRODUCTION_PIPELINE_ORG, "projects.manage": "org", "crm.read": "org", "publish.manage": "org" },
  },
  {
    key: "script_writer",
    name: "Script Writer",
    description: "Drafts and submits scripts for assigned content.",
    mfaRequired: false,
    audience: "staff",
    grants: { "script.write": "own", "content.read": "own" },
  },
  {
    key: "camera_operator",
    name: "Camera Operator",
    description: "Executes assigned shoots and uploads footage.",
    mfaRequired: false,
    audience: "staff",
    grants: { "shoot.execute": "own", "footage.upload": "own", "media.upload": "own", "content.read": "own" },
  },
  {
    key: "video_editor",
    name: "Video Editor",
    description: "Works on assigned edits and submits cuts.",
    mfaRequired: false,
    audience: "staff",
    grants: { "edit.work": "own", "media.read": "own", "media.download": "own", "media.upload": "own" },
  },
  {
    key: "camera_editor",
    name: "Camera / Editor (hybrid)",
    description: "Both camera and editing duties, tracked separately.",
    mfaRequired: false,
    audience: "staff",
    grants: {
      "shoot.execute": "own",
      "footage.upload": "own",
      "edit.work": "own",
      "media.read": "own",
      "media.download": "own",
      "media.upload": "own",
    },
  },
  {
    key: "social_media_manager",
    name: "Social Media Manager",
    description: "Schedules posts, records publishing, manages analytics.",
    mfaRequired: false,
    audience: "staff",
    grants: {
      "content.read": "org",
      "publish.manage": "org",
      "analytics.read": "org",
      "analytics.manage": "org",
      "media.read": "org",
    },
  },
  {
    key: "sales_executive",
    name: "Sales Executive",
    description: "Leads, follow-ups, proposals for own pipeline.",
    mfaRequired: false,
    audience: "staff",
    grants: { "sales.read": "own", "sales.manage": "own", "crm.read": "own" },
  },
  {
    key: "employee",
    name: "Employee",
    description: "Self-service only.",
    mfaRequired: false,
    audience: "staff",
    grants: {},
  },
  {
    key: "client_user",
    name: "Client (portal)",
    description: "External client: own projects, approvals, invoices if authorised.",
    mfaRequired: false,
    audience: "client",
    grants: { "review.client": "own", "content.read": "own" },
  },
];

/** Effective grants for a staff member holding the given role keys (union, widest scope wins). */
export function effectiveGrants(roles: readonly Pick<RoleDef, "grants" | "audience">[]): Grants {
  const out: Grants = {};
  const isStaff = roles.some((r) => r.audience === "staff");
  const sources = isStaff ? [EMPLOYEE_BASE, ...roles.map((r) => r.grants)] : roles.map((r) => r.grants);
  for (const g of sources) {
    for (const [k, s] of Object.entries(g) as [PermissionKey, Scope][]) {
      out[k] = widerScope(out[k] ?? null, s) ?? s;
    }
  }
  return out;
}

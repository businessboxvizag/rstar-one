import { DEFAULT_ROLES, EMPLOYEE_BASE, PERMISSIONS, effectiveGrants } from "../src/permissions.js";

const roles = DEFAULT_ROLES;
const abbr = { own: "Own", team: "Team", department: "Dept", branch: "Branch", org: "All" } as const;
const lines: string[] = [];
lines.push("# Role and permission matrix", "");
lines.push("_Generated from `packages/shared/src/permissions.ts` by `pnpm --filter @rstar/shared run docs:permissions`. Do not edit by hand._", "");
lines.push("Scopes: **Own** = records the person owns or is assigned to · **Team** = plus direct reports · **Dept** = their department (all branches) · **Branch** = their branch · **All** = whole organisation. A wider scope includes the narrower ones. Blank = no access. ⚠ = sensitive (always audited; withheld until MFA is set up for privileged roles).", "");
lines.push("Every staff role also receives the base self-service grants: " + Object.keys(EMPLOYEE_BASE).map((k) => `\`${k}\``).join(", ") + ".", "");
lines.push("## Roles", "");
lines.push("| Role | Key | MFA required | Who |", "|---|---|---|---|");
for (const r of roles) lines.push(`| ${r.name} | \`${r.key}\` | ${r.mfaRequired ? "Yes" : "No"} | ${r.description} |`);
lines.push("", "Separation of duties: HR Admin prepares payroll (`payroll.process`) but cannot approve it; Management approves (`payroll.approve`) but cannot prepare it. Finance Admin records transactions; approvals above the configured threshold need `finance.approve` (Management).", "");
lines.push("HR Admin can create accounts and assign non-privileged roles. Only holders of `roles.manage` (Super Admin) can assign roles that require MFA. Nobody can change their own roles.", "");
lines.push("## Matrix (effective grants, including base self-service)", "");
const header = ["Permission", ...roles.map((r) => r.key)];
lines.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
const eff = roles.map((r) => effectiveGrants([r]));
let module = "";
for (const p of PERMISSIONS) {
  if (p.module !== module) {
    module = p.module;
    lines.push(`| **${module}** |${roles.map(() => " ").join("|")}|`);
  }
  const sens = "sensitive" in p && p.sensitive ? " ⚠" : "";
  lines.push(`| \`${p.key}\`${sens}<br><sub>${p.description}</sub> | ${eff.map((g) => (g[p.key] ? abbr[g[p.key]!] : "")).join(" | ")} |`);
}
console.log(lines.join("\n"));

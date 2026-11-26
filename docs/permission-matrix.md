# Role and permission matrix

_Generated from `packages/shared/src/permissions.ts` by `pnpm --filter @rstar/shared run docs:permissions`. Do not edit by hand._

Scopes: **Own** = records the person owns or is assigned to · **Team** = plus direct reports · **Dept** = their department (all branches) · **Branch** = their branch · **All** = whole organisation. A wider scope includes the narrower ones. Blank = no access. ⚠ = sensitive (always audited; withheld until MFA is set up for privileged roles).

Every staff role also receives the base self-service grants: `employees.read`, `attendance.self`, `attendance.read`, `attendance.approve`, `leave.self`, `leave.read`, `leave.approve`, `payroll.self`, `projects.read`, `tasks.self`, `content.read`, `media.read`, `assets.read`.

## Roles

| Role | Key | MFA required | Who |
|---|---|---|---|
| Super Admin / Owner | `super_admin` | Yes | Full system configuration and emergency access. |
| Management | `management` | Yes | Organisation-wide oversight and approvals. No role/system configuration. |
| Branch Manager | `branch_manager` | Yes | Operational lead for one branch. |
| Department Head | `department_head` | No | Leads one department: team, tasks, approvals. |
| HR Admin | `hr_admin` | Yes | Employee records, attendance, leave and payroll processing. |
| Finance Admin | `finance_admin` | Yes | Invoices, bills, expenses, payments, finance reports. |
| Project Manager / Producer | `project_manager` | No | Plans content, assigns crew and editors, runs reviews. |
| Script Writer | `script_writer` | No | Drafts and submits scripts for assigned content. |
| Camera Operator | `camera_operator` | No | Executes assigned shoots and uploads footage. |
| Video Editor | `video_editor` | No | Works on assigned edits and submits cuts. |
| Camera / Editor (hybrid) | `camera_editor` | No | Both camera and editing duties, tracked separately. |
| Social Media Manager | `social_media_manager` | No | Schedules posts, records publishing, manages analytics. |
| Sales Executive | `sales_executive` | No | Leads, follow-ups, proposals for own pipeline. |
| Employee | `employee` | No | Self-service only. |
| Client (portal) | `client_user` | No | External client: own projects, approvals, invoices if authorised. |

Separation of duties: HR Admin prepares payroll (`payroll.process`) but cannot approve it; Management approves (`payroll.approve`) but cannot prepare it. Finance Admin records transactions; approvals above the configured threshold need `finance.approve` (Management).

HR Admin can create accounts and assign non-privileged roles. Only holders of `roles.manage` (Super Admin) can assign roles that require MFA. Nobody can change their own roles.

## Matrix (effective grants, including base self-service)

| Permission | super_admin | management | branch_manager | department_head | hr_admin | finance_admin | project_manager | script_writer | camera_operator | video_editor | camera_editor | social_media_manager | sales_executive | employee | client_user |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Organisation** | | | | | | | | | | | | | | | |
| `org.settings.manage` ⚠<br><sub>Change organisation profile, product name and branding</sub> | All |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `org.structure.manage` ⚠<br><sub>Create/rename/deactivate branches, departments, teams, designations</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| `roles.manage` ⚠<br><sub>Create custom roles and change role permissions</sub> | All |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `users.manage` ⚠<br><sub>Create accounts, assign roles, reset access, deactivate users</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| `audit.read` ⚠<br><sub>Read the audit log</sub> | All | All |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `channels.manage`<br><sub>Configure channels, clients' content prefixes and ID sequences</sub> | All |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **HRMS** | | | | | | | | | | | | | | | |
| `employees.read`<br><sub>View employee profiles (non-sensitive fields)</sub> | All | All | Branch | Dept | All | Own | Own | Own | Own | Own | Own | Own | Own | Own |  |
| `employees.manage`<br><sub>Create/edit employees, transfers, probation, exits</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| `employees.sensitive.read` ⚠<br><sub>View bank, salary and identity document details</sub> | All | All |  |  | All |  |  |  |  |  |  |  |  |  |  |
| **Attendance** | | | | | | | | | | | | | | | |
| `attendance.self`<br><sub>Check in/out and request corrections for oneself</sub> | All | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own |  |
| `attendance.read`<br><sub>View attendance records</sub> | All | All | Branch | Dept | All | Team | Team | Team | Team | Team | Team | Team | Team | Team |  |
| `attendance.approve` ⚠<br><sub>Approve corrections, exceptions and manual attendance</sub> | All | All | Branch | Dept | All | Team | Team | Team | Team | Team | Team | Team | Team | Team |  |
| `attendance.configure` ⚠<br><sub>Configure geofences, shifts, late/early rules</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| **Leave** | | | | | | | | | | | | | | | |
| `leave.self`<br><sub>Apply for, cancel and view own leave</sub> | All | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own |  |
| `leave.read`<br><sub>View leave requests and balances</sub> | All | All | Branch | Dept | All | Team | Team | Team | Team | Team | Team | Team | Team | Team |  |
| `leave.approve`<br><sub>Approve or reject leave requests</sub> | All | All | Branch | Dept | All | Team | Team | Team | Team | Team | Team | Team | Team | Team |  |
| `leave.configure` ⚠<br><sub>Configure leave types, accrual and carry-forward</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| **Payroll** | | | | | | | | | | | | | | | |
| `payroll.self`<br><sub>View and download own payslips</sub> | All | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own |  |
| `payroll.read` ⚠<br><sub>View payroll runs and salary data</sub> | All | All |  |  | All | All |  |  |  |  |  |  |  |  |  |
| `payroll.process` ⚠<br><sub>Prepare payroll drafts, adjustments, advances</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| `payroll.approve` ⚠<br><sub>Approve and lock payroll runs (separate from processing)</sub> | All | All |  |  |  |  |  |  |  |  |  |  |  |  |  |
| `payroll.configure` ⚠<br><sub>Configure salary components and statutory settings</sub> | All |  |  |  | All |  |  |  |  |  |  |  |  |  |  |
| **Projects** | | | | | | | | | | | | | | | |
| `projects.read`<br><sub>View projects</sub> | All | All | Branch | Dept | Own | Own | All | Own | Own | Own | Own | Own | Own | Own |  |
| `projects.manage`<br><sub>Create projects and manage membership</sub> | All | All | Branch | Dept |  |  | All |  |  |  |  |  |  |  |  |
| `tasks.self`<br><sub>Work on tasks assigned to oneself</sub> | All | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own |  |
| `tasks.manage`<br><sub>Create, assign and re-prioritise tasks</sub> | All | All | Branch | Dept |  |  | All |  |  |  |  |  |  |  |  |
| **Production** | | | | | | | | | | | | | | | |
| `content.read`<br><sub>View content items and their history</sub> | All | All | Branch | Dept | Own | Own | All | Own | Own | Own | Own | All | Own | Own | Own |
| `content.create`<br><sub>Create content items (allocates a Content ID)</sub> | All | All | Branch |  |  |  | All |  |  |  |  |  |  |  |  |
| `content.assign`<br><sub>Assign owners, reassign and escalate content</sub> | All | All | Branch | Dept |  |  | All |  |  |  |  |  |  |  |  |
| `content.cancel`<br><sub>Cancel content items (ID is never reused)</sub> | All | All |  |  |  |  | All |  |  |  |  |  |  |  |  |
| `script.write`<br><sub>Draft and submit scripts</sub> | All |  |  |  |  |  |  | Own |  |  |  |  |  |  |  |
| `script.review`<br><sub>Review scripts</sub> | All | All |  |  |  |  | All |  |  |  |  |  |  |  |  |
| `script.approve`<br><sub>Approve or reject scripts</sub> | All | All |  |  |  |  | All |  |  |  |  |  |  |  |  |
| `shoot.schedule`<br><sub>Schedule shoots and allocate crew/equipment</sub> | All | All | Branch |  |  |  | All |  |  |  |  |  |  |  |  |
| `shoot.execute`<br><sub>Start/complete assigned shoots</sub> | All |  |  |  |  |  |  |  | Own |  | Own |  |  |  |  |
| `footage.upload`<br><sub>Upload footage and register Drive links</sub> | All | All |  |  |  |  | All |  | Own |  | Own |  |  |  |  |
| `footage.verify`<br><sub>Verify, accept or reject footage</sub> | All | All | Branch |  |  |  | All |  |  |  |  |  |  |  |  |
| `edit.assign`<br><sub>Assign editors</sub> | All | All | Branch |  |  |  | All |  |  |  |  |  |  |  |  |
| `edit.work`<br><sub>Work on edits and submit cuts</sub> | All |  |  |  |  |  |  |  |  | Own | Own |  |  |  |  |
| `review.internal`<br><sub>Internal review of cuts</sub> | All | All |  | Dept |  |  | All |  |  |  |  |  |  |  |  |
| `review.client`<br><sub>Client-side approval of scripts and cuts (portal)</sub> |  |  |  |  |  |  |  |  |  |  |  |  |  |  | Own |
| `content.final_approve`<br><sub>Give final approval for publishing</sub> | All | All |  |  |  |  | All |  |  |  |  |  |  |  |  |
| **Social** | | | | | | | | | | | | | | | |
| `publish.manage`<br><sub>Schedule posts and record published URLs</sub> | All | All |  |  |  |  | All |  |  |  |  | All |  |  |  |
| `analytics.read`<br><sub>View analytics snapshots and reports</sub> | All | All |  |  |  |  | All |  |  |  |  | All |  |  |  |
| `analytics.manage`<br><sub>Enter/import analytics and manage platform connections</sub> | All |  |  |  |  |  |  |  |  |  |  | All |  |  |  |
| **Storage** | | | | | | | | | | | | | | | |
| `media.read`<br><sub>Browse media metadata and previews</sub> | All | All | Branch | Dept | Own | Own | All | Own | Own | Own | Own | All | Own | Own |  |
| `media.upload`<br><sub>Create upload sessions</sub> | All | All | Branch |  |  |  | All |  | Own | Own | Own |  |  |  |  |
| `media.download`<br><sub>Download original media (logged)</sub> | All | All |  |  |  |  | All |  |  | Own | Own |  |  |  |  |
| `media.manage` ⚠<br><sub>Archive, restore, retention and deletion approvals</sub> | All |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **CRM** | | | | | | | | | | | | | | | |
| `crm.read`<br><sub>View clients, contacts and deliverables</sub> | All | All |  |  |  | All | All |  |  |  |  |  | Own |  |  |
| `crm.manage`<br><sub>Manage clients, contracts and contacts</sub> | All | All |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **Sales** | | | | | | | | | | | | | | | |
| `sales.read`<br><sub>View leads and pipeline</sub> | All | All |  |  |  |  |  |  |  |  |  |  | Own |  |  |
| `sales.manage`<br><sub>Manage leads, proposals and quotations</sub> | All |  |  |  |  |  |  |  |  |  |  |  | Own |  |  |
| **Finance** | | | | | | | | | | | | | | | |
| `finance.read` ⚠<br><sub>View invoices, payments, expenses and reports</sub> | All | All |  |  |  | All |  |  |  |  |  |  |  |  |  |
| `finance.manage` ⚠<br><sub>Create invoices, bills, expenses and payments</sub> | All |  |  |  |  | All |  |  |  |  |  |  |  |  |  |
| `finance.approve` ⚠<br><sub>Approve purchases/expenses above threshold</sub> | All | All |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **Assets** | | | | | | | | | | | | | | | |
| `assets.read`<br><sub>View equipment and office assets</sub> | All | All | Branch | Own | All | All | Own | Own | Own | Own | Own | Own | Own | Own |  |
| `assets.manage`<br><sub>Manage assets, assignment, maintenance</sub> | All |  | Branch |  |  |  |  |  |  |  |  |  |  |  |  |
| **Reports** | | | | | | | | | | | | | | | |
| `reports.read`<br><sub>View dashboards and reports</sub> | All | All | Branch | Dept | All | All |  |  |  |  |  |  |  |  |  |

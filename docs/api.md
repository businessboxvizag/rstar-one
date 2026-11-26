# API contracts (v1)

Base URL: `/v1`. JSON only. Auth: `Authorization: Bearer <accessToken>`. ✅ = implemented and covered by integration tests. 🗓 = contract defined, lands in the named milestone.

## Conventions

* **Errors:** `{ "error": { "code": "validation_failed" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "locked" | "mfa_required" | "mfa_invalid" | "internal", "message": "...", "details"?: {...} } }`. Out-of-scope records return **404**, not 403.
* **Validation:** request bodies use the Zod schemas in `@rstar/shared/schemas.ts`; the same schemas are used by web and mobile forms.
* **Pagination:** `?limit=1..100&cursor=…` → `{ items, nextCursor }` (keyset, never offset).
* **Concurrency:** workflow mutations take `expectedVersion`; a stale version returns **409** with the current version.
* **Idempotency** (🗓 M2+): mutations that a mobile client may retry (check-in, upload completion) accept an `Idempotency-Key` header.
* **Rate limits:** 600 req/min per IP globally; login, invite and reset endpoints `LOGIN_RATE_LIMIT_PER_MINUTE` per IP+email.

## Auth and session ✅

| Method & path | Body → Response | Notes |
|---|---|---|
| `POST /auth/login` | `{ email, password, totp? }` → `{ accessToken, refreshToken, expiresIn, sessionId }` | 401 generic message for unknown user or wrong password; `mfa_required` if TOTP enabled; 423 after 5 failures |
| `POST /auth/refresh` | `{ refreshToken }` → new pair | Refresh token rotates; the old one stops working |
| `POST /auth/logout` | — | Revokes this session |
| `GET /me` | → `{ user, roles, permissions, security, organisation }` | `permissions` is `{ key: scope }` for UI decisions |
| `GET /me/sessions`, `DELETE /me/sessions/:id` | | Device/session management |
| `POST /auth/password` | `{ currentPassword, newPassword }` | Revokes other sessions |
| `POST /auth/mfa/setup` → `POST /auth/mfa/confirm` | → `{ secret, otpauthUrl }`; `{ totp }` | TOTP enrolment |
| `POST /auth/invite/accept` | `{ token, newPassword }` | Activates an invited account |
| `POST /auth/password-reset/request` | `{ email }` → 202 always | No account enumeration |
| `POST /auth/password-reset/confirm` | `{ token, newPassword }` | Revokes all sessions |

## Organisation ✅

| Method & path | Permission | Notes |
|---|---|---|
| `GET /organisation`, `PATCH /organisation` | read: any; write: `org.settings.manage` | Product name is configurable here |
| `GET/POST /branches`, `PATCH /branches/:id` | write: `org.structure.manage` | Rename, deactivate via `active:false` |
| `GET/POST /departments`, `PATCH /departments/:id` | same | |
| `GET/POST /designations`, `PATCH /designations/:id` | same | |
| `GET /channels`, `POST /channels` | write: `channels.manage` | Creating a channel creates its Content ID sequence `{ name, prefix, segmentMode?, padding? }` |
| `GET /clients`, `POST /clients` | write: `crm.manage` + `channels.manage` | Portal users only ever see their own client |
| `PATCH /content-sequences/:id` | `channels.manage` | Changing a prefix retires the old one forever |
| `GET /permissions`, `GET /roles` | `users.manage` | Catalogue and roles with grants |
| `POST /roles`, `PUT /roles/:id/permissions` | `roles.manage` | Custom roles; Super Admin role cannot be reduced |
| `GET /audit` | `audit.read` | Filters: `entityType, entityId, actorUserId, action` |

## Employees ✅

| Method & path | Permission | Notes |
|---|---|---|
| `GET /employees` | `employees.read` (scoped) | Filters: `branchId, departmentId, status, q` |
| `GET /employees/:id` | `employees.read` (scoped) | Includes roles; no sensitive fields |
| `POST /employees` | `employees.manage` + `users.manage` | Creates login + profile + roles. Without `initialPassword` returns a one-time `inviteUrl` (72 h) and emails it (test mode logs it) |
| `PATCH /employees/:id` | `employees.manage` | Transfers (org scope only), status changes (`exited` deactivates login), manager, designation → history |
| `PUT /employees/:id/roles` | `users.manage`; privileged roles need `roles.manage` | Cannot change own roles |
| `GET /employees/:id/history` | `employees.manage` | |
| `GET/PUT /employees/:id/sensitive` | `employees.sensitive.read` (or self for GET) | Encrypted at rest, every read audited |
| `POST /employees/:id/deactivate`, `POST /employees/:id/reset-access` | `users.manage` | Immediate session revocation |

## Content and production ✅ (core)

| Method & path | Permission | Notes |
|---|---|---|
| `POST /content` | `content.create` | Allocates the Content ID server-side. Body: `CreateContentInput` (exactly one of `clientId`/`channelId`) |
| `GET /content` | `content.read` (scoped) | Filters: `stage, clientId, channelId, branchId, mine, overdue, q` (`q` matches Content ID prefix or title) |
| `GET /content/:idOrCode` | `content.read` | Accepts UUID or Content ID (case-insensitive). Returns `actions` the caller may take now |
| `GET /content/:idOrCode/history` | staff only | Full lifecycle history with actors and notes |
| `POST /content/:id/transition` | per-transition permission (see [workflows.md](workflows.md)) | `{ to, note?, assigneeUserId?, stageDueAt?, expectedVersion }`; rejections require `note`; assignee must hold the matching permission |
| `GET/POST /content/:id/comments` | `content.read` | `visibility: internal | client`; portal users only see client comments |
| `GET /content-pipeline` | `content.read` | Per-stage counts and overdue counts for the dashboard |
| `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | self | In-app notifications |

## Planned contracts 🗓

**Attendance (M2)**
`POST /attendance/check-in` / `check-out` `{ lat, lng, accuracyM, clientTime, mode: office|wfh|field, mockLocation?, deviceId }` → `{ result: verified|outside_geofence|low_accuracy|pending_exception, distanceM, flags[] }` · `GET /attendance/me?month=` · `GET /attendance?date=&branchId=` · `POST /attendance/corrections` · `POST /attendance/corrections/:id/decision` · `GET/PUT /geofences/:branchId` · `GET /attendance/reports/monthly`

**Leave (M2)** `GET/POST /leave-types` · `GET /leave/balances/me` · `POST /leave/requests` · `POST /leave/requests/:id/{approve|reject|cancel|withdraw}` · `GET /leave/calendar?branchId=&departmentId=`

**Payroll (M3)** `GET/POST /salary-components` · `PUT /employees/:id/salary` · `POST /payroll/runs` `{ period }` · `POST /payroll/runs/:id/{validate|review|approve|mark-paid|lock}` · `GET /payroll/runs/:id/register` · `GET /payroll/runs/:id/bank-export.csv` · `GET /payslips/me` · `GET /payslips/:id.pdf`

**Tasks (M4)** `GET/POST /projects` · `GET/POST /tasks` · `PATCH /tasks/:id` · `POST /tasks/:id/comments` · `POST /tasks/:id/dependencies` · `GET /tasks?view=kanban|calendar|list`

**Production detail (M5)** `POST /content/:id/scripts` · `POST /scripts/:id/versions` · `POST /content/:id/shoots` · `POST /shoots/:id/{start|complete}` · `POST /content/:id/editing-assignments` · `POST /editing/:id/{start|pause|resume|submit}` · `POST /content/:id/approvals`

**Storage (M6)** `POST /uploads` `{ contentId, folder, fileName, size, mime, sha256 }` → `{ uploadId, partSize, parts: [{ n, url }] }` · `GET /uploads/:id` (parts received, for resume) · `POST /uploads/:id/parts` (more presigned URLs) · `POST /uploads/:id/complete` `{ parts: [{ n, etag, sha256 }] }` → asset · `POST /uploads/:id/abort` · `GET /media?contentId=&folder=&q=` · `POST /media/:id/download-url` (logged, short-lived) · `POST /external-links` (register Drive link) · `GET /storage/usage`

**Social and analytics (M7)** `POST /content/:id/posts` · `POST /posts/:id/published` `{ url, externalId, publishedAt }` · `POST /posts/:id/snapshots` `{ window, source: manual, metrics }` · `POST /analytics/import.csv` · `GET /analytics/reports` · `GET/POST /platform-accounts` (OAuth start/callback)

**CRM, sales, finance, assets, reports (M7–M9)** Standard CRUD under `/contacts`, `/leads`, `/proposals`, `/invoices`, `/payments`, `/bills`, `/expenses`, `/purchase-requests`, `/vendors`, `/accounts`, `/assets`; `GET /reports/:report?from=&to=&format=json|csv|xlsx`.

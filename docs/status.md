# Milestone status

_Updated 26 Nov 2026 — end of Milestone 2 (attendance and leave)._

## Implemented and tested

| Area | What works | Evidence |
|---|---|---|
| Monorepo | pnpm workspace: API, web, mobile, shared package; root `typecheck`/`test`/`build` | `pnpm typecheck`, `pnpm test` |
| Shared domain | Permission catalogue (58 permissions, 5 scopes), 14 default roles + base employee grants, 29-stage production workflow, Content ID formatting, Zod schemas, brand tokens, storage cost model | 15 unit tests |
| Database | Migrations 0001–0002 (organisation, structure, identity, RBAC, employees, sensitive HR data, history, audit, clients, channels, Content ID sequences, content items, history, comments, notifications); append-only and no-delete triggers | applied by test setup on every run |
| Seed | Visakhapatnam + Hyderabad, 8 departments, designations, roles, 5 RSTAR channels (RN/RH/RB/RE/RO), 4 clients (CarCart CC, Avakai AV, Avakai.com AVC, Pulse Hospital PH), first Super Admin | `pnpm db:seed` |
| Auth | Login, lockout, refresh rotation, logout, device sessions, password change, invitations, password reset (no enumeration), TOTP MFA, MFA enforcement for privileged roles | `apps/api/test/auth.test.ts` (10 tests) |
| RBAC | Scoped visibility (own/team/department/branch/org), 404 for out-of-scope, HR cannot grant privileged roles, no self-role changes, immediate deactivation, custom roles | `rbac.test.ts` (12 tests) |
| Employees | Create with login + roles + invite link, update, transfers, exit, history, encrypted bank/PAN/UAN with audited reads | `rbac.test.ts`, `audit.test.ts` |
| Content IDs | Server-side, sequential per client/channel, unique under 60 concurrent requests, never reused after cancellation, delete blocked, prefix retirement, year and campaign segments, search by ID | `content-id.test.ts` (7 tests) |
| Production workflow | Every stage idea → archived with owners, permission + scope checks, assignee qualification, required rejection reasons, revision counting, history, notifications, optimistic locking, client portal approval with client-safe fields | `workflow.test.ts` (5 tests) |
| Audit | Append-only, redacted, readable only with `audit.read` | `audit.test.ts` (4 tests) |
| Web app | Login (with MFA step), collapsible sidebar + mobile drawer, global Content ID search, dashboard (live pipeline counts, my work, notifications), production list/filters/create, content detail with workflow actions, assignment, history, comments, people directory + add employee/invite, audit log, security settings (password, MFA QR, sessions) | Production build passes; browser run-through on a seeded database (login → create CC001 → assign script → audit) with no console errors |
| Mobile app | Expo app: secure sign-in with MFA, refresh token in OS keychain, profile, My work list | Typecheck passes; Android bundle exports. **Not yet run on a device/simulator.** |
| **M2 Attendance** | Migration 0003. GPS check-in/out with server-side verdicts (geofence distance, accuracy, mock location, impossible travel, clock skew), office / field / WFH modes by policy, versioned location consent, idempotent submits, night-shoot check-out, daily ledger (present / late / half day / absent / leave / holiday / weekly off / needs review) rebuilt from events + corrections + leave + holidays, exception review, correction requests and manual entries, register by scope, geofence + working-hours + holiday setup | 12 rule unit tests, `attendance.test.ts` (8 tests), browser run-through (set geofence from location → consent → verified check-in → register) |
| **M2 Leave** | Leave types (seeded CL/SL/EL/LOP defaults, editable), monthly/yearly accrual with joining pro-rating, balances, apply with half days, holiday/weekly-off exclusion, overlap and balance checks, document threshold, manager approval with optimistic locking, withdraw/cancel with balance restore, HR adjustments, year-end carry forward, ledger integration | `leave.test.ts` (5 tests) |
| Web (M2) | My attendance (check in/out with browser GPS, consent notice, month ledger, corrections), Team attendance (review queue with map link, daily register), Leave (balances, apply, my requests, approvals), Attendance setup (geofences with "use my location", rules, holidays, leave types) | Production build; browser run-through; no horizontal scroll at 390 px |
| Mobile (M2) | Check in/out card with foreground-only GPS (`expo-location`), consent prompt, Android mock-location flag, mode picker | Typecheck; Android bundle exports. **Not yet run on a device.** |
| Fixes found in M2 | Web could not send PUT/PATCH/DELETE (CORS default only allowed GET/POST), now fixed and tested. Two refreshes at once (two tabs, or right after sign-in) logged the user out; refresh tokens now have a 20-second grace window, and reuse after it revokes the session | `auth.test.ts` |
| Docs | Architecture + ADRs, data model, permission matrix (generated), API contracts, workflows, storage + cost model, security + location policy, deployment | `docs/` |

## Needs external accounts or credentials (test mode until then)

| Integration | Current state | Needed |
|---|---|---|
| Email | **Test mode**: emails are logged, not sent; invite links are shown to the admin | SMTP provider credentials, sending domain with SPF/DKIM |
| GitHub + CI | Workflow file ready, not running | A GitHub repository to push to |
| Hosting | Runs locally | Hosting accounts (web, API, managed Postgres) |
| Cloudflare R2 / backup | Designed, not built (Milestone 6) | Cloudflare account + R2 token; separate backup account |
| Meta / YouTube APIs | Designed (Milestone 7) | Meta app with review, YouTube API project, OAuth consent |
| Push notifications, app stores | Not started | Expo account, Google Play Console, Apple Developer Program |

## Not yet built (next milestones)

Payroll (M3, uses the attendance ledger and unpaid leave), projects and tasks, script editor and shoot management, media upload and library, social publishing and analytics, CRM detail, sales, finance, assets, reports and exports, client-user provisioning UI, organisation settings UI, push/email notification delivery, backups and restore tests, end-to-end browser test suite in CI, mobile device tests.

## Known limitations

* Office geofences are **not** pre-filled: an admin must set each branch from the real office location (Attendance setup → "Use my current location" while standing in the office). Until then, office check-ins go to review.
* Seeded leave quotas (CL 12 monthly, SL 12 yearly with document after 2 days, EL 15 monthly with 30 carry-forward, LOP unlimited) are common Indian defaults, not your HR policy. Please confirm or change them.
* Leave approval is one level (reporting manager, or anyone above with approve scope). A second HR step can be added if you want it.
* Leave documents are a text reference until file upload lands (M6). Push notifications for approvals arrive with the notification milestone; in-app notifications work now.
* GPS cannot defeat a rooted phone that fakes coordinates perfectly; the flags and manager review are the control.

* Login assumes one organisation per email address (true for this deployment).
* The client portal currently uses the same web app; client users are created directly in the database until the CRM milestone adds the UI.
* Not production-ready: no security review, load test, backup drill or legal review of payroll/privacy yet.

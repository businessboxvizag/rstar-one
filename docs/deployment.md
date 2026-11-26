# Local setup and deployment

## Local development

Requirements: Node 22, pnpm 10, PostgreSQL 16 (local install or `docker compose up -d db`).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # then fill JWT_SECRET, DATA_ENCRYPTION_KEY, SEED_ADMIN_*
# generate keys:
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('DATA_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"

createdb rstar_one_dev && createdb rstar_one_test   # or use docker compose
pnpm --filter @rstar/shared build
pnpm db:migrate
pnpm db:seed          # creates branches, departments, roles, channels, clients, prefixes, first Super Admin
pnpm dev:api          # http://localhost:4000
pnpm dev:web          # http://localhost:3000
pnpm test             # shared unit tests + API integration tests against rstar_one_test
```

### First admin account

`pnpm db:seed` creates the Super Admin from `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME` and `SEED_ADMIN_PASSWORD`. The password must be changed at first login and, with `MFA_ENFORCEMENT=on`, the admin must enrol an authenticator app before using admin features. Then: Settings → People → Add employee (sends an invitation link; while email is in test mode the link is shown to the admin to share).

## Environments

| | local | CI | staging | production |
|---|---|---|---|---|
| Database | local Postgres | Postgres service container | managed Postgres (small) | managed Postgres with PITR, daily backups, encryption |
| Media | — (M6: MinIO) | MinIO | R2 bucket `rstar-one-staging` | R2 bucket `rstar-one-prod` + backup |
| Email | log (test mode) | memory | SMTP sandbox | SMTP provider (SPF/DKIM) |
| MFA_ENFORCEMENT | off allowed | both tested | on | on (startup refuses otherwise) |
| Demo data | optional, labelled | — | optional | refused |

## Hosting recommendation

* **Web:** Vercel (or any Node host) — `apps/web`, env `NEXT_PUBLIC_API_URL`.
* **API + worker:** a container platform in an Indian region where possible (e.g. AWS ap-south-1 Mumbai / ap-south-2 Hyderabad, or Railway/Render/Fly with a nearby region). `pnpm --filter @rstar/api build && node apps/api/dist/src/server.js`; run `db:migrate` as a release step.
* **Database:** managed Postgres in the same region (Neon, Supabase, RDS).
* **Secrets:** platform secret store; never in the repository. Rotate `JWT_SECRET` by deploying a new value (all users re-login); `DATA_ENCRYPTION_KEY` rotation needs a re-encryption job (documented in M10).
* **Monitoring:** structured JSON logs (pino), Sentry for errors, uptime check on `/health`.

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs install → build shared → typecheck → tests (with a Postgres 16 service) → web build on every push and pull request. It activates when the code is pushed to a GitHub repository.

## Mobile builds

Expo EAS: `eas build -p android` / `-p ios`. Requires an Expo account, Google Play Console account and Apple Developer Program membership (blocked on accounts).

## Vercel (team `business-box`)

Two Vercel projects from the same GitHub repository, plus a hosted Postgres:

| Project | Root directory | Config | Environment variables |
|---|---|---|---|
| `rstar-one-web` | `apps/web` | `apps/web/vercel.json` | `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL` = the API project's URL |
| `rstar-one-api` | `apps/api` | `apps/api/vercel.json` (serverless entry `api/index.ts`) | everything in `apps/api/.env.example`: `DATABASE_URL` (pooled), `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `CORS_ORIGINS` = web URL, `APP_BASE_URL` = web URL, `MFA_ENFORCEMENT=on`, `MAIL_TRANSPORT`, `NODE_ENV` |

Database: Neon Postgres from the Vercel Marketplace (pick the Singapore or Mumbai region if offered, close to India). Use the **pooled** connection string for `DATABASE_URL`. Run migrations and the seed once from a trusted machine:

```bash
DATABASE_URL="<neon direct (non-pooled) URL>" pnpm db:migrate
DATABASE_URL="<neon direct URL>" SEED_ADMIN_EMAIL=… SEED_ADMIN_NAME=… SEED_ADMIN_PASSWORD=… pnpm db:seed
```

Notes:
* `NODE_ENV=production` refuses to start until `MAIL_TRANSPORT=smtp` is configured. Until SMTP credentials exist, deploy as a **preview/staging** environment with `NODE_ENV=development` and `MAIL_TRANSPORT=log` (test mode, clearly not production).
* The background worker (notification delivery, analytics pulls, proxies) from later milestones does not fit serverless; it will run on Vercel Cron for light jobs or a small container host.

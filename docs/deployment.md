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

<p align="center"><img src="brand/rstar-tv-logo.png" width="96" alt="RSTAR TV"></p>

# RSTAR ONE

The organisation operating system for **RSTAR TV** — people, attendance, payroll, media production, storage, publishing, clients and finance across Visakhapatnam and Hyderabad.
_Technology & Operations by BusinessBOX._

> Status: **Milestone 2 (attendance with GPS, leave)**. See [docs/status.md](docs/status.md) for exactly what is implemented, tested, and waiting on credentials.

## Repository

| Path | What |
|---|---|
| `apps/api` | Node 22 + Fastify API, PostgreSQL migrations, integration tests |
| `apps/web` | Next.js web app (staff and client portal) |
| `apps/mobile` | Expo app for Android and iOS |
| `packages/shared` | Permissions, workflows, Content IDs, validation schemas, brand tokens, cost model |
| `docs` | Architecture, data model, permission matrix, API, workflows, storage, security, deployment |

## Quick start

```bash
pnpm install
docker compose up -d db                 # or a local PostgreSQL 16 with rstar_one_dev + rstar_one_test
cp apps/api/.env.example apps/api/.env  # fill in secrets and SEED_ADMIN_*
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @rstar/shared build
pnpm db:migrate && pnpm db:seed
pnpm dev:api    # :4000
pnpm dev:web    # :3000
pnpm test
```

Full instructions: [docs/deployment.md](docs/deployment.md).

## Documentation

* [Architecture and plan](docs/architecture.md) · [ADRs](docs/adr)
* [Data model](docs/data-model.md)
* [Role and permission matrix](docs/permission-matrix.md)
* [API contracts](docs/api.md)
* [Workflows and state transitions](docs/workflows.md)
* [Storage architecture and cost model](docs/storage-and-cost.md)
* [Security, privacy and location policy](docs/security.md)
* [Milestone status](docs/status.md)

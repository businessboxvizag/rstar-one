#!/usr/bin/env bash
# Runs during the Vercel build of the API: applies pending migrations and the idempotent seed.
# Uses the direct (non-pooled) Neon URL when available, since migrations take an advisory lock.
set -euo pipefail
URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
if [ -z "$URL" ]; then
  echo "[vercel-db] No database connected to this project yet; skipping migrations."
  exit 0
fi
cd "$(dirname "$0")/.."
DATABASE_URL="$URL" npx tsx src/cli/migrate.ts
DATABASE_URL="$URL" npx tsx src/cli/seed.ts

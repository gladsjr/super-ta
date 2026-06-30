#!/bin/bash
set -euo pipefail

echo "[post-merge] npm install"
npm install --no-audit --no-fund --no-progress

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[post-merge] applying migrations (npm run db:migrate)"
  npm run db:migrate
else
  echo "[post-merge] DATABASE_URL not set, skipping migrations"
fi

echo "[post-merge] done"

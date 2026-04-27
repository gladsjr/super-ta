#!/bin/bash
set -euo pipefail

echo "[post-merge] npm install"
npm install --no-audit --no-fund --no-progress

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[post-merge] applying schema.sql to DATABASE_URL"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
else
  echo "[post-merge] DATABASE_URL not set, skipping schema apply"
fi

echo "[post-merge] done"

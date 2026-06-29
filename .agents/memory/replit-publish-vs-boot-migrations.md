---
name: Replit publish flow vs app boot-time DDL migrations
description: Why prod migrations crash on boot on Replit, and the right fix (sync the ledger, not idempotency)
---

On Replit, the prod schema is touched by TWO systems that conflict:
1. The app's own boot-time migration runner (`lib/migrations.js`, called from server boot) — runs raw DDL and records each file in `schema_migrations`.
2. Replit's Publish flow — auto-diffs the dev schema against prod and applies the diff to prod WITHOUT touching the app's `schema_migrations` ledger.

**Failure mode:** a new migration (e.g. `ADD COLUMN`) runs in dev. On publish, Replit copies the column to prod but does not record the migration in `schema_migrations`. Next prod boot, the runner sees the version unrecorded, re-runs the DDL, hits "column already exists" (42701), throws, and aborts boot → production Internal Server Error on every restart.

**Fix for an occurrence:** INSERT the missing version(s) into prod `schema_migrations` (`ON CONFLICT DO NOTHING`) so the runner skips them. This is what resolved the 007/008 incident. Then verify prod's real columns/constraints match dev (compare `information_schema.columns` + `pg_constraint`) so the ledger isn't lying about a column that's actually missing.

**Do NOT make 002+ migrations idempotent (`ADD COLUMN IF NOT EXISTS`) to dodge this.** (a) CLAUDE.md mandates 001 = idempotent snapshot, 002+ = pure deltas; (b) editing an already-applied migration is forbidden by CLAUDE.md (breaks cross-env reproducibility) — 007/008 are already applied in dev; (c) `IF NOT EXISTS` silently accepts type/null/default drift, violating the project's fail-fast principle. A failing migration is a *useful* drift signal.

**Why:** this is structural, not a one-time legacy artifact. It can recur on every future migration as long as boot-time DDL runs alongside Replit's publish diff. 005/006 already carry `IF EXISTS`/`IF NOT EXISTS` guards documenting the same reality (prod columns created outside the migration regime).

**How to apply:** when prod shows "column already exists" on boot, or Internal Server Error right after a deploy that added a migration, compare `schema_migrations` in prod against the `migrations/` folder and sync the ledger. If hardening is wanted, prefer a pre-flight drift check in the runner over blanket idempotency, or reconsider running boot-time DDL on Replit at all (Replit guidance flags startup-time DDL as an anti-pattern; prod schema is meant to be owned by the Publish diff).

## Atualização (jun/2026): nesta app, migrations SAÍRAM do boot — não sincronize prod à mão

A arquitetura mudou desde o incidente 007/008. Hoje:
- `server.js` **NÃO** roda migrations no boot; `scripts/migrate.mjs` (→ `lib/migrations.js`) é o ÚNICO migrador e roda só em DEV (workflow `npm run db:migrate && node server.js` e `predev`).
- O deploy roda `node server.js` (sem `db:migrate`). Logo o boot de PROD nunca reexecuta DDL → o crash "column already exists" **não ocorre mais** nesta arquitetura.
- O schema de prod é do fluxo de **Publish do Replit** (diff dev→prod aplicado quando o usuário publica). É o caminho sancionado pela skill `database` (ver `references/database-migrations-on-publish.md`).

**Correção do conselho antigo:** NÃO faça mais "sync do ledger" (INSERT em `schema_migrations` de prod) nem rode DDL/scripts contra produção — isso agora CONTRADIZ a skill `database` ("o agente não deve escrever código/scripts para migrar o banco de produção"; queries em prod são read-only). Aquele fix era para a arquitetura antiga (DDL no boot). O `schema_migrations` de prod pode ficar defasado, e tudo bem: nada lê esse ledger em prod.

**How to apply hoje:** mudou schema? Aplique em DEV (`db:migrate`), valide, e diga ao usuário para **republicar** — o Publish faz o diff. Rename/alter destrutivo gera prompt de confirmação no Publish UI; adições puras de coluna/constraint (caso da prova oral 021–028) saem limpas, sem renames.

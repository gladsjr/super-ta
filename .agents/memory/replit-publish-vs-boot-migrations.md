---
name: Replit publish flow owns the prod schema (no boot-time migrations)
description: Nesta app o schema de prod é do Publish diff do Replit; não rode DDL nem sincronize o ledger em prod
---

Regra atual (durável): nesta app as migrations **não** rodam no boot. `scripts/migrate.mjs` (→ `lib/migrations.js`) é o ÚNICO migrador e roda só em DEV (workflow `npm run db:migrate && node server.js`, `predev`, e `scripts/post-merge.sh`). O deploy roda `node server.js` — sem `db:migrate`.

Consequência: o schema de PROD é aplicado pelo fluxo de **Publish do Replit** (diff dev→prod, quando o usuário publica). É o caminho sancionado pela skill `database` (ver `references/database-migrations-on-publish.md`).

**Não faça:** sync do ledger (INSERT em `schema_migrations` de prod) nem rodar DDL/scripts contra produção. A skill `database` proíbe (o agente não migra o banco de prod; queries em prod são read-only). O `schema_migrations` de prod pode ficar defasado — tudo bem, nada o lê em prod.

**How to apply:** mudou schema? Aplique em DEV (`db:migrate`), valide, e peça ao usuário para **republicar** — o Publish faz o diff. Adições puras de coluna/constraint saem limpas; rename/alter destrutivo gera prompt de confirmação no Publish UI. Pós-publish, confirme em prod via SQL **read-only** (`information_schema.columns` + `pg_constraint`) que as colunas/constraints novas chegaram (CHECK constraints em especial — propagação não deve ser assumida).

**Por que existia conselho antigo (superado):** numa arquitetura anterior o `server.js` rodava DDL no boot; o Publish copiava a coluna para prod mas não registrava no `schema_migrations`, então o próximo boot reexecutava o DDL e quebrava com "column already exists" (42701) → erro 500 em todo restart. Naquele mundo o fix era sincronizar o ledger à mão. **Isso não se aplica mais** porque o boot não roda mais migrations — se você ver esse conselho em algum lugar, ele é da arquitetura antiga.

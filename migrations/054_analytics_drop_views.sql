-- Remove a CAMADA DE VIEWS de análise (schema `analytics` + 5 views + função
-- try_jsonb) e a coluna de opt-out. Decisão de produto: as views eram defesa
-- em profundidade contra nós mesmos (esconder PII, conter o alcance das
-- consultas), redundante frente ao modelo de acesso adotado — token gerado no
-- admin por um usuário que já tem direito a TODOS esses dados, com expiração,
-- revogação e auditoria. O endpoint passa a consultar as TABELAS-BASE direto.
--
-- Bônus: as views/schema/função são objetos que o Publish do Replit NÃO
-- propaga (só reconcilia tabelas/colunas/índices em `public`). Sem eles, o
-- endpoint não depende de nenhum objeto não-diff-ável — funciona em prod sem
-- pegadinha de propagação. As tabelas `analytics_tokens` e `analytics_query_log`
-- (em `public`) FICAM: auth por token e auditoria seguem valendo.
--
-- A segurança real nunca dependeu das views: transação READ ONLY (o Postgres
-- recusa escrita/DDL), statement_timeout, LIMIT, guarda de SELECT-único e
-- bloqueio de catálogo do sistema (pg_*), tudo em routes/analytics.js.
--
-- Roda no dev (o schema existe lá, criado pela 052). Em prod a coluna
-- analytics_opt_out existe (é diff-ável, propagou) e o Publish aplica o DROP;
-- o schema/views/função nunca chegaram a prod, então lá são irrelevantes.

DROP SCHEMA analytics CASCADE;

ALTER TABLE works DROP COLUMN analytics_opt_out;

-- Fila de JOBS de processamento pesado (issue #289, corte 3).
--
-- Fila NO BANCO, deliberadamente agnóstica de quem executa: hoje o executor é
-- o próprio app (janela ociosa, lib/jobRunner.js); amanhã pode ser um worker
-- em projeto Replit separado consumindo a MESMA tabela via API interna
-- (degrau 2 da estratégia) — nada muda aqui na transição.
--
-- Reivindicação atômica por lease: FOR UPDATE SKIP LOCKED + lease_until.
-- Lease vencida = executor morreu no meio → o job volta a ficar elegível
-- (com attempts incrementado; attempts >= max vira 'failed'). Idempotência é
-- responsabilidade do processador de cada tipo (ex.: retranscrição regrava
-- final_transcript — reprocessar é inócuo).
--
-- type é TEXT livre (não CHECK nem tabela-FK): tipos de job são detalhe de
-- código com um único produtor/consumidor, não enumeração de domínio exposta
-- — e a ADR 0011 pesa contra CHECK de strings de qualquer forma.
CREATE TABLE jobs (
    id            BIGSERIAL PRIMARY KEY,
    type          TEXT NOT NULL,
    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 3,
    lease_until   TIMESTAMPTZ,
    last_error    TEXT,
    result        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- O claim varre pending (e running com lease vencida) do mais antigo ao mais novo.
CREATE INDEX jobs_claim_idx ON jobs (status, created_at) WHERE status IN ('pending', 'running');
CREATE INDEX jobs_submission_idx ON jobs (submission_id);

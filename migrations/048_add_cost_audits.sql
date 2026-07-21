-- Auditoria de custo: reconcilia o custo CALCULADO localmente (work_cost_events,
-- tokens × config/pricing.yaml) contra o consumo REAL reportado pela OpenAI
-- (Usage API por tokens; Costs API por US$ no nível projeto/dia).
--
-- Duas camadas de latência:
--   - Usage API atualiza em ~minutos/horas → confere TOKENS por modelo logo após o run.
--   - Costs API só fecha ~no dia seguinte → US$ faturado do projeto entra depois.
-- Por isso o registro nasce `pending` e vira `settled` quando a Costs do dia fecha.
--
-- Campos JSON (por modelo) guardam o detalhamento; os *_usd/_pct guardam o resumo.

CREATE TABLE cost_audits (
    id                    BIGSERIAL PRIMARY KEY,
    benchmark_run_id      TEXT NULL,                 -- run reconciliado (ou NULL p/ janela livre)
    window_start          TIMESTAMPTZ NOT NULL,      -- janela de tempo auditada (UTC)
    window_end            TIMESTAMPTZ NOT NULL,

    -- Lado CALCULADO (agregado de work_cost_events dos works de benchmark do run).
    calculated_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
    calculated_tokens_json JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { "<model>": { input, cached, output, ... } }

    -- Lado REAL da Usage API (tokens/seg/chars por modelo, já filtrado pela chave de benchmark).
    actual_usage_tokens_json JSONB NULL,                          -- { "<model>": { input, cached, output, ... } }
    reference_usd         NUMERIC(12,6) NULL,        -- tokens_reais(Usage) × pricing.yaml

    -- Cross-check da Costs API (US$ faturado no nível projeto/dia; mesmo projeto ⇒ inclui produção).
    costs_api_project_usd NUMERIC(12,6) NULL,

    -- Deltas (real − calculado).
    delta_tokens_json     JSONB NULL,                -- { "<model>": { input, output, ... } }
    delta_usd             NUMERIC(12,6) NULL,        -- reference_usd − calculated_usd
    delta_pct             NUMERIC(8,4) NULL,         -- delta_usd / calculated_usd × 100

    status                TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'settled' | 'error'
    note                  TEXT NULL,                 -- mensagem de erro/observação
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at            TIMESTAMPTZ NULL,

    CONSTRAINT cost_audits_status_chk CHECK (status IN ('pending', 'settled', 'error'))
);

CREATE INDEX cost_audits_run_idx ON cost_audits (benchmark_run_id) WHERE benchmark_run_id IS NOT NULL;
CREATE INDEX cost_audits_window_idx ON cost_audits (window_start, window_end);

-- Reinicio autorizado da infraestrutura experimental do ORATIA Bench.
-- Os dados anteriores nao implementavam o contrato completo do superorquestrador.
TRUNCATE TABLE
  benchmark_call_ledger,
  benchmark_consensus,
  benchmark_judgments,
  benchmark_model_outputs,
  benchmark_runs,
  benchmark_releases,
  benchmark_setup_versions,
  benchmark_setup_generations,
  benchmark_setup_drafts,
  benchmark_jury_versions
RESTART IDENTITY CASCADE;

ALTER TABLE benchmark_model_outputs
  ADD COLUMN IF NOT EXISTS output_json JSONB,
  ADD COLUMN IF NOT EXISTS schema_valid BOOLEAN,
  ADD COLUMN IF NOT EXISTS validation_errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS action_assessment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS actionable_latency_ms INTEGER;

ALTER TABLE benchmark_consensus
  ADD COLUMN IF NOT EXISTS action_assessment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS candidate_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS actionable_latency_ms INTEGER;

ALTER TABLE benchmark_setup_generations
  ADD COLUMN IF NOT EXISTS progress_done INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS known_cost_usd NUMERIC(14, 8),
  ADD COLUMN IF NOT EXISTS progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ALTER COLUMN mode SET DEFAULT 'llm_council';

CREATE TABLE benchmark_generation_calls (
  id                 BIGSERIAL PRIMARY KEY,
  generation_key     TEXT NOT NULL REFERENCES benchmark_setup_generations(generation_key) ON DELETE CASCADE,
  call_id            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  effort             TEXT,
  role               TEXT NOT NULL,
  case_id             TEXT,
  turn_id             TEXT,
  request_json        JSONB NOT NULL,
  response_json       JSONB NOT NULL,
  request_hash        TEXT NOT NULL,
  response_hash       TEXT NOT NULL,
  usage_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms          INTEGER,
  cost_estimated_usd NUMERIC(14, 8),
  cost_source        TEXT NOT NULL DEFAULT 'unavailable',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (generation_key, call_id)
);

CREATE INDEX benchmark_generation_calls_key_idx
  ON benchmark_generation_calls (generation_key, case_id, turn_id, role);

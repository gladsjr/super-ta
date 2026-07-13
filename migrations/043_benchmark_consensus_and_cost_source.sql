ALTER TABLE benchmark_model_outputs ALTER COLUMN cost_estimated_usd DROP NOT NULL;
ALTER TABLE benchmark_model_outputs ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated';

ALTER TABLE benchmark_call_ledger ALTER COLUMN cost_estimated_usd DROP NOT NULL;
ALTER TABLE benchmark_call_ledger ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated';

CREATE TABLE benchmark_consensus (
  id                 BIGSERIAL PRIMARY KEY,
  run_key            TEXT NOT NULL REFERENCES benchmark_runs(run_key) ON DELETE CASCADE,
  case_id            TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  candidate_key      TEXT NOT NULL,
  score_general      NUMERIC(5, 4) NOT NULL CHECK (score_general BETWEEN -1 AND 1),
  dimensions_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence         NUMERIC(5, 4),
  critical_failure   BOOLEAN NOT NULL DEFAULT false,
  judge_count        INTEGER NOT NULL,
  agreement_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  needs_deliberation BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (run_key, case_id, turn_id, candidate_key)
);

CREATE INDEX benchmark_consensus_run_idx ON benchmark_consensus (run_key, candidate_key);

CREATE TABLE benchmark_runs (
  run_key           TEXT PRIMARY KEY,
  benchmark         TEXT NOT NULL,
  setup_version     TEXT NOT NULL,
  context_version   TEXT NOT NULL,
  jury_version      TEXT NOT NULL,
  mode              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'validated')),
  config_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_json      JSONB,
  metrics_json      JSONB,
  artifact_dir      TEXT,
  error_text        TEXT,
  progress_done     INTEGER NOT NULL DEFAULT 0,
  progress_total    INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
);

CREATE INDEX benchmark_runs_created_at_idx ON benchmark_runs (created_at DESC);
CREATE INDEX benchmark_runs_status_idx ON benchmark_runs (status);

CREATE TABLE benchmark_model_outputs (
  id                 BIGSERIAL PRIMARY KEY,
  run_key            TEXT NOT NULL REFERENCES benchmark_runs(run_key) ON DELETE CASCADE,
  case_id            TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  candidate_key      TEXT NOT NULL,
  output_text        TEXT NOT NULL,
  usage_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms         INTEGER,
  cost_estimated_usd NUMERIC(14, 8) NOT NULL DEFAULT 0
);

CREATE INDEX benchmark_outputs_run_idx ON benchmark_model_outputs (run_key, case_id, turn_id);

CREATE TABLE benchmark_judgments (
  id                 BIGSERIAL PRIMARY KEY,
  run_key            TEXT NOT NULL REFERENCES benchmark_runs(run_key) ON DELETE CASCADE,
  case_id            TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  candidate_key      TEXT NOT NULL,
  judge_key          TEXT NOT NULL,
  candidate_position CHAR(1) NOT NULL CHECK (candidate_position IN ('A', 'B')),
  score_general      NUMERIC(5, 4) NOT NULL CHECK (score_general BETWEEN -1 AND 1),
  dimensions_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence         NUMERIC(5, 4),
  critical_failure   BOOLEAN NOT NULL DEFAULT false,
  rationale          TEXT
);

CREATE INDEX benchmark_judgments_run_idx ON benchmark_judgments (run_key, candidate_key);

CREATE TABLE benchmark_call_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  run_key            TEXT NOT NULL REFERENCES benchmark_runs(run_key) ON DELETE CASCADE,
  call_key           TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  effort             TEXT,
  role               TEXT NOT NULL,
  case_id            TEXT,
  turn_id            TEXT,
  candidate_key      TEXT,
  request_hash       TEXT NOT NULL,
  response_hash      TEXT NOT NULL,
  usage_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms         INTEGER,
  cost_estimated_usd NUMERIC(14, 8) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_key, call_key)
);

CREATE INDEX benchmark_ledger_run_idx ON benchmark_call_ledger (run_key, role);

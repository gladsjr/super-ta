-- 003_add_work_budget.sql
-- Per-work spend control. Each work_token has a USD budget set by an admin
-- on creation; every LLM call (responses, tts, stt) debits the running total.
-- When spent_usd >= budget_usd, the work is blocked from new student turns.

ALTER TABLE works
  ADD COLUMN budget_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN spent_usd  NUMERIC(10,4) NOT NULL DEFAULT 0;

ALTER TABLE works
  ADD CONSTRAINT works_budget_nonneg_chk CHECK (budget_usd >= 0),
  ADD CONSTRAINT works_spent_nonneg_chk  CHECK (spent_usd  >= 0);

-- Per-call ledger. Each row corresponds to one OpenAI API call that incurred
-- cost. Kept for auditability and admin debugging; the running total in
-- works.spent_usd is updated atomically alongside each insert.
CREATE TABLE work_cost_events (
  id              SERIAL PRIMARY KEY,
  work_id         INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  submission_id   INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,        -- 'responses' | 'tts' | 'stt'
  model           TEXT NOT NULL,
  agent_label     TEXT,                 -- e.g. 'AGENT:Comprehension', 'QUESTION_GEN'
  input_tokens    INTEGER,
  cached_tokens   INTEGER,
  output_tokens   INTEGER,
  audio_seconds   NUMERIC(10,2),
  audio_chars     INTEGER,
  cost_usd        NUMERIC(12,6) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_cost_events_type_chk CHECK (event_type IN ('responses','tts','stt'))
);

CREATE INDEX work_cost_events_work_idx ON work_cost_events (work_id, created_at DESC);

-- Sistema multiagente de CENÁRIOS: sai do store JSON (data/scenarios/) para o
-- Postgres. Definição em JSONB (itera rápido; mesmo padrão de runtime_state_json);
-- runs guardados para execução/auditoria/avaliação.
--
-- Delta puro (sem IF NOT EXISTS), conforme CLAUDE.md (migrations >= 002).

CREATE TABLE scenario_templates (
  id          TEXT PRIMARY KEY,                 -- t_*
  data        JSONB NOT NULL,                   -- persona completa (nome, papel, voz, gênero, objetivos, ...)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scenarios (
  id          TEXT PRIMARY KEY,                 -- s_*
  work_id     INTEGER REFERENCES works(id) ON DELETE CASCADE,  -- um cenário por work; NULL = catálogo
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { personas:[...], interactions:[...], pdf, coherence }
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No máximo um cenário por trabalho.
CREATE UNIQUE INDEX scenarios_work_id_uniq ON scenarios (work_id) WHERE work_id IS NOT NULL;

CREATE TABLE scenario_runs (
  id                TEXT PRIMARY KEY,            -- r_*
  scenario_id       TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  submission_id     INTEGER REFERENCES submissions(id) ON DELETE CASCADE,  -- quando ligado ao fluxo do aluno
  mode              TEXT NOT NULL DEFAULT 'mock',          -- 'mock' | 'live'
  interaction_index INTEGER NOT NULL DEFAULT 0,
  transcript        JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory            JSONB,
  evaluation_json   JSONB,                       -- relatório interno (ScenarioEvaluatorAgent)
  grades_json       JSONB,                       -- notas (GradingAgent + weightedFinal)
  done              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scenario_runs_scenario_idx ON scenario_runs (scenario_id);
CREATE INDEX scenario_runs_submission_idx ON scenario_runs (submission_id);

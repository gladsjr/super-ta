-- 001_init.sql — Initial schema snapshot.
--
-- This is the bootstrap migration. It must be IDEMPOTENT: it may run on a
-- completely empty database (greenfield) or on a database that already has
-- some/all of the schema (legacy environment that ran the old `schema.sql`
-- before the migrations runner existed). All statements use IF NOT EXISTS
-- so either case converges to the same target state. Once recorded in
-- `schema_migrations`, it never runs again.
--
-- Future schema changes go into NEW files (002_*.sql, 003_*.sql, ...) — do
-- NOT edit this file after deploy. See CLAUDE.md "Schema do banco" for the
-- full convention.

-- App users. Password hashes are bcrypt; seeded by seedInitialUsers() in auth.js
-- from the INITIAL_USERS env var on boot.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session store for connect-pg-simple. Schema is fixed by the library.
-- Source: https://github.com/voxpelli/node-connect-pg-simple#table-structure
CREATE TABLE IF NOT EXISTS app_session (
  sid    VARCHAR       NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON          NOT NULL,
  expire TIMESTAMP(6)  NOT NULL
);

CREATE INDEX IF NOT EXISTS app_session_expire_idx ON app_session (expire);

-- Shared interviewer agenda templates (replaces config/interviewers/*.yaml).
-- Filename is preserved as the public identifier for backwards compat with
-- /interviewers/templates/:filename.
CREATE TABLE IF NOT EXISTS interviewer_templates (
  id           SERIAL PRIMARY KEY,
  filename     TEXT UNIQUE NOT NULL,
  yaml_text    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Works (replaces data/works/<workToken>-<label>/).
CREATE TABLE IF NOT EXISTS works (
  id                        SERIAL PRIMARY KEY,
  work_token                CHAR(12) UNIQUE NOT NULL,
  name                      TEXT NOT NULL,
  enunciado_pdf             BYTEA,
  enunciado_filename        TEXT,
  interviewer_yaml          TEXT,
  enunciado_coherence_json  TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Patch for legacy DBs that pre-date the enunciado_coherence_json column.
-- No-op on greenfield (column already created above).
ALTER TABLE works ADD COLUMN IF NOT EXISTS enunciado_coherence_json TEXT;

CREATE INDEX IF NOT EXISTS works_token_idx ON works (work_token);

-- Submissions (replaces submissions/<submissionToken>-<label>/).
-- Status is derived: final_report_json => "finalized";
-- otherwise student_pdf or conversation_json present => "in_progress";
-- otherwise => "pending".
CREATE TABLE IF NOT EXISTS submissions (
  id                    SERIAL PRIMARY KEY,
  submission_token      CHAR(12) UNIQUE NOT NULL,
  work_id               INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  student_label         TEXT NOT NULL,
  student_pdf           BYTEA,
  student_pdf_filename  TEXT,
  conversation_json     TEXT,
  final_report_json     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_token_idx ON submissions (submission_token);
CREATE INDEX IF NOT EXISTS submissions_work_idx  ON submissions (work_id);

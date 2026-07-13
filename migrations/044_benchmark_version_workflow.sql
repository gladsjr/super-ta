CREATE TABLE benchmark_setup_drafts (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  config_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'archived')),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE benchmark_setup_generations (
  generation_key TEXT PRIMARY KEY,
  setup_draft_id BIGINT NOT NULL REFERENCES benchmark_setup_drafts(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  mode            TEXT NOT NULL DEFAULT 'fixture_snapshot',
  config_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json     JSONB,
  artifact_dir    TEXT,
  error_text      TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE benchmark_setup_versions (
  version_key          TEXT PRIMARY KEY,
  version_major        INTEGER NOT NULL CHECK (version_major >= 0),
  version_minor        INTEGER NOT NULL CHECK (version_minor >= 0),
  version_build        INTEGER NOT NULL CHECK (version_build >= 0),
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  classification       TEXT NOT NULL DEFAULT 'validated' CHECK (classification IN ('fixture', 'experimental', 'validated')),
  source_generation_key TEXT REFERENCES benchmark_setup_generations(generation_key) ON DELETE RESTRICT,
  manifest_json        JSONB NOT NULL,
  manifest_hash        TEXT NOT NULL,
  published_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_major, version_minor, version_build)
);

CREATE TABLE benchmark_jury_versions (
  version_key    TEXT PRIMARY KEY,
  version_major  INTEGER NOT NULL CHECK (version_major >= 0),
  version_minor  INTEGER NOT NULL CHECK (version_minor >= 0),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  config_json    JSONB NOT NULL,
  manifest_hash  TEXT NOT NULL,
  published_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_major, version_minor)
);

CREATE TABLE benchmark_releases (
  release_key       TEXT PRIMARY KEY,
  setup_version_key TEXT NOT NULL REFERENCES benchmark_setup_versions(version_key) ON DELETE RESTRICT,
  jury_version_key  TEXT NOT NULL REFERENCES benchmark_jury_versions(version_key) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  manifest_json     JSONB NOT NULL,
  manifest_hash     TEXT NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (setup_version_key, jury_version_key)
);

ALTER TABLE benchmark_runs ADD COLUMN release_key TEXT REFERENCES benchmark_releases(release_key) ON DELETE RESTRICT;
ALTER TABLE benchmark_runs ADD COLUMN candidate_fingerprint TEXT;
CREATE INDEX benchmark_runs_duplicate_idx ON benchmark_runs (release_key, candidate_fingerprint, status);

-- SuperTA — database schema for local bootstrap.
-- Apply once (idempotent): psql "$DATABASE_URL" -f schema.sql
--
-- Works, submissions, assignment PDFs, interviewers and final reports live
-- entirely on the filesystem under data/works/<token>-<label>/. The database
-- only holds app users and the session store.

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

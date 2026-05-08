-- 002_add_interaction_mode.sql
-- Adds per-work interaction mode (text vs audio) and voice selection.
-- Default 'text' preserves behavior for existing works.

ALTER TABLE works ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'text';
ALTER TABLE works ADD COLUMN voice TEXT;
ALTER TABLE works ADD CONSTRAINT works_interaction_mode_chk
  CHECK (interaction_mode IN ('text', 'audio'));

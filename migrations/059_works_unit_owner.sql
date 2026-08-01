-- Vínculo do trabalho com a árvore (unit) e com um dono (owner). AMBOS nullable:
-- preserva "trabalho sem professor" e o modo token-only (demo/avulsos).
--
-- A POSSE do trabalho — que dá poder (distribuir tokens de entrevista, ver
-- avaliações) — vem de owner_user_id / membership de professor na sub-árvore da
-- unidade OU da simples posse do work_token. Resolução em lib/rbac.js. Trabalho
-- com owner+unit NULL cai no comportamento de hoje (token-only).
ALTER TABLE works ADD COLUMN unit_id       INTEGER REFERENCES units(id) ON DELETE SET NULL;
ALTER TABLE works ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE works ADD COLUMN source        TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX works_unit_idx  ON works (unit_id);
CREATE INDEX works_owner_idx ON works (owner_user_id);

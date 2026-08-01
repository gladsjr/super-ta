-- Estrutura institucional: unidades GENÉRICAS e RECURSIVAS (árvore por parent_id).
-- "instituição / campus / departamento / curso / turma" são apenas o rótulo
-- `label` (exibição), nunca tipos distintos. O sistema não impõe hierarquia de
-- tipos: qualquer nó pode conter qualquer nó.
--
-- Aditivo e OPCIONAL: nada aqui afeta trabalhos/submissões legados, que ficam
-- com unit_id NULL e seguem no modo token-only.
--
-- budget_usd: teto em US$ DESTA unidade (Portão A). NULL = sem teto próprio →
-- a unidade fica limitada pelo ancestral vinculante mais próximo que tiver teto.
-- source: manual | imported | synced (rastro da integração gradual).
CREATE TABLE units (
  id          SERIAL PRIMARY KEY,
  parent_id   INTEGER REFERENCES units(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  label       TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  budget_usd  NUMERIC(12,4),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX units_parent_idx ON units (parent_id);

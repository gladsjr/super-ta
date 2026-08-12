-- Estrutura institucional: unidades GENÉRICAS e RECURSIVAS (árvore por parent_id).
-- "instituição / campus / departamento / curso / turma" são apenas o rótulo
-- `label` (exibição), nunca tipos distintos. O sistema não impõe hierarquia de
-- tipos: qualquer nó pode conter qualquer nó.
--
-- Aditivo e OPCIONAL: nada aqui afeta trabalhos/submissões legados, que ficam
-- com unit_id NULL e seguem no modo token-only.
--
-- budget_usd: RESERVA em US$ desta unidade (Portão A). NULL = sem teto próprio →
-- a unidade consome do saldo do ancestral vinculante mais próximo que tiver teto.
-- Definir/aumentar o teto de uma filha debita o saldo do pai no ato (reserva);
-- reduzir devolve. Ver lib/billing.js.
-- source: manual | imported | synced (rastro da integração gradual).
--
-- is_class: marca a unidade como TURMA (contexto de trabalho). Trabalhos só
-- podem ser criados em unidades com is_class=true, e turma não pode ter filhos.
-- Ortogonal à posição na árvore: a raiz pode ser turma (professor independente).
CREATE TABLE units (
  id          SERIAL PRIMARY KEY,
  parent_id   INTEGER REFERENCES units(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  label       TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  budget_usd  NUMERIC(12,4),
  is_class    BOOLEAN NOT NULL DEFAULT false,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX units_parent_idx ON units (parent_id);

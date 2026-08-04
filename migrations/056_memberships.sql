-- Controle de acessos: vínculo PESSOA → PAPEL, POR UNIDADE (RBAC tenant-aware).
-- A mesma pessoa pode ter papéis diferentes em unidades diferentes (e em
-- instituições diferentes): professora na Turma A e admin do Departamento X.
--
-- Papéis vivem numa TABELA (roles), não num CHECK de strings — padrão do
-- projeto para enumerações que podem evoluir: id numérico interno + `key`
-- estável que o código referencia + `name` de exibição (traduzível). Evoluir a
-- enumeração vira DML (o Publish do Replit não propaga mudança de definição de
-- constraint com o mesmo nome). As linhas são sincronizadas no boot por
-- seedRoles() (auth.js) a partir de ROLE_DEFS em lib/rbac.js.
--
-- Herança: SÓ papéis de administração herdam para a sub-árvore (decisão de
-- 04/08/2026 — "disponibilidade não é acesso"). Professor e aluno são LOCAIS ao
-- nó: vínculo em ancestral torna a pessoa DISPONÍVEL para escolha nas unidades
-- descendentes, nunca membro automático. Resolução em lib/rbac.js, nunca
-- cacheada na sessão.
--
-- unit_id NULL + papel admin_global = admin do sistema (vale em toda a árvore).
CREATE TABLE roles (
  id    SERIAL PRIMARY KEY,
  key   TEXT UNIQUE NOT NULL,
  name  TEXT NOT NULL
);

CREATE TABLE memberships (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unit_id    INTEGER REFERENCES units(id) ON DELETE CASCADE,
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, unit_id, role_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_unit_idx ON memberships (unit_id);

-- A UNIQUE acima não impede duplicatas quando unit_id é NULL (NULL <> NULL no
-- Postgres). Este índice parcial garante um único vínculo GLOBAL por (user, role).
CREATE UNIQUE INDEX memberships_global_uidx
  ON memberships (user_id, role_id) WHERE unit_id IS NULL;

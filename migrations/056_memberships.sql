-- Controle de acessos: vínculo PESSOA → PAPEL, POR UNIDADE (RBAC tenant-aware).
-- A mesma pessoa pode ter papéis diferentes em unidades diferentes (e em
-- instituições diferentes): professora na Turma A e admin do Departamento X.
--
-- unit_id NULL + role='admin_global' = admin do sistema (vale em toda a árvore).
-- Papéis herdam PARA BAIXO: um papel numa unidade vale nela e em toda a
-- sub-árvore (resolução em lib/rbac.js, nunca cacheada na sessão).
CREATE TABLE memberships (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unit_id    INTEGER REFERENCES units(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN (
               'admin_global','admin_unidade','professor','funcionario','aluno')),
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, unit_id, role)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_unit_idx ON memberships (unit_id);

-- A UNIQUE acima não impede duplicatas quando unit_id é NULL (NULL <> NULL no
-- Postgres). Este índice parcial garante um único vínculo GLOBAL por (user, role).
CREATE UNIQUE INDEX memberships_global_uidx
  ON memberships (user_id, role) WHERE unit_id IS NULL;

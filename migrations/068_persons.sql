-- PESSOA — o agregador do humano, separado da conta-de-e-mail (`users`).
-- Decisão de 05/08/2026 (docs/auth-multitenant-plan.md): `users` continua sendo a
-- conta-de-e-mail (1 e-mail, N identidades, memberships); `persons` é uma camada
-- FINA por cima, chaveada por identificador civil, que junta os e-mails do mesmo
-- humano (users.person_id) e serve de ponte para o futuro (credenciais de carreira,
-- biometria). Não governa acesso — isso segue por e-mail/vínculo.
--
-- civil_id em TABELA-LOOKUP (padrão enum-por-tabela do projeto; nunca CHECK de
-- string): hoje só 'cpf'; internacionalização depois = novas linhas. O valor é
-- string genérica (aceita formatos distintos). Único por (tipo, valor) quando
-- presente — nullable, pois estrangeiro sem CPF ainda não é suportado.
CREATE TABLE civil_id_types (
  id   SERIAL PRIMARY KEY,
  key  TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE persons (
  id               SERIAL PRIMARY KEY,
  civil_id_type_id INTEGER REFERENCES civil_id_types(id),
  civil_id_value   TEXT,
  display_name     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- tipo e valor andam juntos
  CONSTRAINT persons_civil_pair_chk CHECK ((civil_id_type_id IS NULL) = (civil_id_value IS NULL))
);

CREATE UNIQUE INDEX persons_civil_uidx
  ON persons (civil_id_type_id, civil_id_value) WHERE civil_id_value IS NOT NULL;

-- A conta-de-e-mail aponta para a pessoa (nullable: contas legadas da equipe e
-- contas antes de informar o CPF ficam sem pessoa). O identificador civil sai de
-- `users` (migration 057) e passa a viver na pessoa — a chave é do humano, não do
-- e-mail. As colunas de 057 estavam sempre NULL (nada as preenchia ainda).
ALTER TABLE users ADD COLUMN person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL;
ALTER TABLE users DROP COLUMN civil_id_type;
ALTER TABLE users DROP COLUMN civil_id_value;

CREATE INDEX users_person_idx ON users (person_id);

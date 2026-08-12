-- Identidade real: a PESSOA (users) separada das IDENTIDADES DE LOGIN (tabela
-- user_identities, migration 066). `username` legado segue funcionando (seed
-- INITIAL_USERS + loginHandler intactos).
--
-- password_hash vira nullable: contas SSO-only não têm senha local.
--
-- civil_id_type/civil_id_value: identificador CIVIL da pessoa — chave preferida
-- de reconciliação (importação, SSO). Por ora só 'cpf'; o par tipo+valor deixa a
-- internacionalização ser só "aceitar novos tipos". NUNCA é a chave primária:
-- pessoa sem CPF existe (aluno estrangeiro) — único quando presente, nullable.
-- LGPD: é dado pessoal; coleta justificada pela desambiguação de cadastros.
--
-- source: manual | imported | synced.
ALTER TABLE users ADD COLUMN email          TEXT;
ALTER TABLE users ADD COLUMN display_name   TEXT;
ALTER TABLE users ADD COLUMN civil_id_type  TEXT;
ALTER TABLE users ADD COLUMN civil_id_value TEXT;
ALTER TABLE users ADD COLUMN source         TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Tipo e valor andam juntos: ou ambos presentes, ou ambos ausentes.
ALTER TABLE users ADD CONSTRAINT users_civil_id_pair_chk
  CHECK ((civil_id_type IS NULL) = (civil_id_value IS NULL));

-- Unicidade case-insensitive de e-mail; unicidade do identificador civil por
-- tipo. Índices parciais para não colidir entre as muitas linhas com NULL.
CREATE UNIQUE INDEX users_email_uidx    ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_civil_id_uidx ON users (civil_id_type, civil_id_value)
  WHERE civil_id_value IS NOT NULL;

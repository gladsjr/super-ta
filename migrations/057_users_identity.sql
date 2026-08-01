-- Identidade real: login local (e-mail) + Google SSO. `username` legado segue
-- funcionando (seed INITIAL_USERS + loginHandler intactos).
--
-- password_hash vira nullable: contas SSO-only não têm senha local.
-- google_sub: subject OIDC do Google (chave estável do provedor).
-- source: manual | imported | synced.
ALTER TABLE users ADD COLUMN email        TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN google_sub   TEXT;
ALTER TABLE users ADD COLUMN source       TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Unicidade case-insensitive de e-mail; unicidade do google_sub. Índices
-- parciais para não colidir entre as muitas linhas legadas com email/sub NULL.
CREATE UNIQUE INDEX users_email_uidx      ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_google_sub_uidx ON users (google_sub)   WHERE google_sub IS NOT NULL;

-- Autenticação federada estruturada em três peças (decisão de 04/08/2026):
--
-- 1) auth_providers: provedores de login como INSTÂNCIAS CONFIGURADAS, não
--    protocolos. Dois campi da mesma instituição podem ter SAML/OIDC distintos —
--    cada um é uma linha, com seu kind (protocolo) e sua configuração.
--    Segredos NÃO vivem aqui: o provedor 'google' padrão lê client_id/secret do
--    env (GOOGLE_CLIENT_ID/...); config_json guarda só o não-sensível (issuer,
--    domínio permitido etc.). Linhas base sincronizadas por seedAuthProviders().
--
-- 2) user_identities: identidades de login da PESSOA — N por usuário (senha
--    local hoje, Google amanhã, SAML institucional depois), 1 dona por
--    (provider, subject). Substitui a antiga coluna users.google_sub: nenhum
--    provedor é cravado no schema de users. A senha local continua em
--    users.password_hash (a linha 'local' existe para política/rastreio).
--
-- 3) unit_auth_policies: quais provedores uma UNIDADE aceita para entrar nos
--    seus contextos. Sem linhas = sem restrição (qualquer provedor ativo).
--    A política é da unidade; a conta é da pessoa — a mesma conta pode usar
--    provedores diferentes em unidades diferentes.
CREATE TABLE auth_providers (
  id          SERIAL PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,   -- estável p/ o código ('local', 'google', ...)
  kind        TEXT NOT NULL,          -- protocolo: local | google | oidc | saml
  name        TEXT NOT NULL,          -- exibição
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,          -- sub OIDC / NameID SAML / id do usuário no provedor
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, subject)
);

CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE unit_auth_policies (
  id          SERIAL PRIMARY KEY,
  unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, provider_id)
);

-- Tenants, domínios (a "pista") e dono do provedor — Fase 0 (resto) do plano
-- multi-institucional (docs/auth-multitenant-plan.md).
--
-- tenant = a instituição-raiz com identidade de login própria: um slug para a
-- porta `oratia.education/<slug>` e a marca visual. Nem toda unidade é tenant;
-- por isso tabela à parte, chaveada pela unidade-raiz.
CREATE TABLE tenants (
  unit_id       INTEGER PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  slug          TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  branding_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- auth_domains: domínio de e-mail ASSOCIADO a um tenant. NÃO roteia
-- automaticamente (decisão de 05/08) — é só a PISTA que, na falha do login pela
-- porta genérica, sugere "entre por /<slug>". A posse do domínio é verificada no
-- onboarding pela equipe, fora do sistema.
CREATE TABLE auth_domains (
  id             SERIAL PRIMARY KEY,
  domain         TEXT UNIQUE NOT NULL,   -- lower, ex.: fgv.br
  tenant_unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_domains_tenant_idx ON auth_domains (tenant_unit_id);

-- Provedor pode PERTENCER a um tenant (federado: o SSO da FGV) ou ser GLOBAL
-- (aberto: local/Google, owner NULL). É isto que separa realm aberto de federado.
ALTER TABLE auth_providers ADD COLUMN owner_tenant_unit_id INTEGER REFERENCES units(id) ON DELETE CASCADE;

CREATE INDEX auth_providers_owner_idx ON auth_providers (owner_tenant_unit_id);

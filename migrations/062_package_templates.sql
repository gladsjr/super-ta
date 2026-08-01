-- Registro dos TEMPLATES de pacote (a "linguagem" de pacotes). Fonte da verdade
-- é o filesystem (config/packages/*.yaml); esta tabela é sincronizada no boot por
-- seedPackageTemplates() em auth.js (mesmo padrão de seedInterviewerTemplates()).
--
-- yaml_text: DSL crua (espelho do arquivo). spec_json: parseado + validado +
-- EXPANDIDO (itens + contadores de prep derivados), pronto para consumo.
CREATE TABLE package_templates (
  id          SERIAL PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  yaml_text   TEXT NOT NULL,
  spec_json   JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

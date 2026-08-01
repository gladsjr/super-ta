-- Alocação de pacotes a uma unidade + cadeia de CASCATA/DELEGAÇÃO.
--
-- REGRA-CHAVE: a distribuição/delegação é em PACOTES INTEIROS, nunca em itens.
--   granted_packages   = quantos pacotes esta unidade controla;
--   delegated_packages = quantos desceram para unidades filhas.
--   retido = granted_packages − delegated_packages (vira capacidade de itens
--            para consumo — ver 064).
-- parent_allocation_id encadeia a delegação (NULL = concessão raiz).
CREATE TABLE package_allocations (
  id                    SERIAL PRIMARY KEY,
  template_key          TEXT NOT NULL REFERENCES package_templates(key),
  template_version      INTEGER NOT NULL,
  unit_id               INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  parent_allocation_id  INTEGER REFERENCES package_allocations(id) ON DELETE CASCADE,
  granted_packages      INTEGER NOT NULL CHECK (granted_packages >= 0),
  delegated_packages    INTEGER NOT NULL DEFAULT 0 CHECK (delegated_packages >= 0),
  granted_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source                TEXT NOT NULL DEFAULT 'manual',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (delegated_packages <= granted_packages)
);

CREATE INDEX pkg_alloc_unit_idx   ON package_allocations (unit_id);
CREATE INDEX pkg_alloc_parent_idx ON package_allocations (parent_allocation_id);

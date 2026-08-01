-- Camada de CONSUMO item a item, derivada dos pacotes retidos na alocação.
--
-- Cada item do template vira um contador (mais os contadores de prep derivados,
-- ex.: 'prova_oral__prep_exec'). item_quantity = quantas unidades do item cada
-- pacote traz (ex.: Autoral simples traz 2 entrevistas simples → item_quantity=2).
--
-- Capacidade do item = (granted_packages − delegated_packages) × item_quantity
--   (join com package_allocations). Disponível = capacidade − consumed_qty.
-- Consumir um item NUNCA move pacote nem toca os outros itens (pool da unidade).
CREATE TABLE entitlement_counters (
  id            SERIAL PRIMARY KEY,
  allocation_id INTEGER NOT NULL REFERENCES package_allocations(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,
  item_quantity INTEGER NOT NULL CHECK (item_quantity >= 1),
  consumed_qty  INTEGER NOT NULL DEFAULT 0 CHECK (consumed_qty >= 0),
  locks_json    JSONB NOT NULL,
  UNIQUE (allocation_id, item_key)
);

CREATE INDEX ent_counters_alloc_idx ON entitlement_counters (allocation_id);

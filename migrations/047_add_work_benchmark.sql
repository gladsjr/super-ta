-- Marca um work como "benchmark de custo": as chamadas à OpenAI desse work usam
-- a chave dedicada OPENAI_API_KEY_BENCHMARK (separa o gasto no painel da OpenAI e
-- viabiliza a auditoria via Usage/Costs API). `benchmark_run_id` agrupa vários works
-- de um mesmo run de benchmark para reconciliar o custo em bloco.
--
-- Ortogonal a `works.kind` (um benchmark pode ser interview ou oral_realtime).

ALTER TABLE works ADD COLUMN is_benchmark BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE works ADD COLUMN benchmark_run_id TEXT NULL;

-- Consulta comum: "todos os works de um run de benchmark".
CREATE INDEX works_benchmark_run_idx ON works (benchmark_run_id) WHERE benchmark_run_id IS NOT NULL;

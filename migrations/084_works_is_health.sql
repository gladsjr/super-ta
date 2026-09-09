-- Trabalho de saúde permanente (#375, corte 4): a marca do trabalho em que o
-- health check pendura o custo dos checks pagos (Responses, STT, TTS e, no
-- corte seguinte, a perna B do Realtime). Decisão de 05/09/2026: o custo da
-- monitoração entra na contabilidade NORMAL (work_cost_events), com nome
-- próprio, para as telas de custo e a reconciliação com a fatura fecharem.
--
-- NÃO se reaproveita is_benchmark: aquela marca roteia as chamadas pela chave
-- de benchmark (lib/openaiClient.js#clientForWork) e tiraria o gasto de saúde
-- da conta normal — o oposto do objetivo.
--
-- A linha é criada pela seed no boot (auth.js#seedHealthWork), não aqui:
-- migration cuida de schema, seed de dados (AGENTS.md). Índice parcial único
-- nomeado: no máximo UM trabalho de saúde.
ALTER TABLE works ADD COLUMN is_health BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX works_is_health_uidx ON works (is_health) WHERE is_health;

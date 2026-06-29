-- Corretiva de propagação ao publicar.
--
-- A migration 022 redefiniu work_cost_events_type_chk (DROP + ADD com o MESMO
-- nome) para aceitar event_type='realtime' (prova oral). Porém o diff de schema
-- do Publish do Replit compara constraints por NOME: como o nome era idêntico em
-- dev e prod, a mudança de DEFINIÇÃO não foi detectada e prod ficou com a CHECK
-- antiga (sem 'realtime'). Resultado: em produção todo recordCost da prova oral
-- falhava com "violates check constraint work_cost_events_type_chk" (o custo é
-- best-effort, então a prova não quebrava, mas spent_usd não era contabilizado).
--
-- Para forçar o diff a materializar a versão correta em prod, RENOMEAMOS a
-- constraint: o Publish verá DROP do nome antigo + ADD do nome novo e aplicará a
-- definição correta. Nada referencia o nome da constraint no código.
ALTER TABLE work_cost_events DROP CONSTRAINT IF EXISTS work_cost_events_type_chk;
ALTER TABLE work_cost_events DROP CONSTRAINT IF EXISTS work_cost_events_event_type_chk;
ALTER TABLE work_cost_events ADD CONSTRAINT work_cost_events_event_type_chk
  CHECK (event_type IN ('responses', 'tts', 'stt', 'realtime'));

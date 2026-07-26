-- 051_add_realtime_token_split.sql
-- Split áudio/texto dos eventos Realtime em work_cost_events.
--
-- Até aqui a tabela guardava só o agregado (input_tokens = áudio+texto somados,
-- cached_tokens, output_tokens). Como o áudio custa ~8× o texto na entrada e na
-- saída, sem o desdobramento não dá para recalcular o custo de voz com exatidão
-- a partir do banco. Estas colunas gravam a fração de ÁUDIO de cada agregado; a
-- fração de TEXTO deriva por subtração (texto = total − áudio).
--
-- Aditivas e NULLABLE de propósito: só os eventos event_type='realtime' as
-- preenchem (em lib/billing.js#recordRealtimeCost). Eventos responses/tts/stt e
-- todas as linhas antigas ficam NULL — sem backfill aqui.
ALTER TABLE work_cost_events
  ADD COLUMN input_audio_tokens  INTEGER,
  ADD COLUMN cached_audio_tokens INTEGER,
  ADD COLUMN output_audio_tokens INTEGER;

-- Prova oral (Realtime) grava custo com event_type='realtime'. A CHECK de
-- work_cost_events (migration 003) só permitia 'responses'/'tts'/'stt'. Amplia.
ALTER TABLE work_cost_events DROP CONSTRAINT work_cost_events_type_chk;
ALTER TABLE work_cost_events ADD CONSTRAINT work_cost_events_type_chk
  CHECK (event_type IN ('responses', 'tts', 'stt', 'realtime'));

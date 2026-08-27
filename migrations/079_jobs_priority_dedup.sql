-- Prioridade + dedup na fila jobs (issue #338).
--
-- A fila de análises de VÍDEO (proctoring) migra da memória para esta infra,
-- como LANE SEPARADA (type='video_analysis') — as duas filas continuam
-- logicamente distintas (política de retry, prioridade e concorrência
-- próprias), mas compartilham a mecânica: claim atômico, lease, retry manual,
-- repriorização e visibilidade.
--
-- priority: menor = primeiro. A retranscrição ignora (fica no default 100 =
-- FIFO puro); o vídeo usa 0 (pedido manual fura fila) e 100 (automático).
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

-- O claim passa a ordenar por (priority, created_at).
DROP INDEX jobs_claim_idx;
CREATE INDEX jobs_claim_idx ON jobs (status, priority, created_at) WHERE status IN ('pending', 'running');

-- Dedup por submissão dentro de cada tipo: no máximo UM job ativo
-- (pending/running) por (type, submission_id) — era o dedup em memória da
-- fila de vídeo; agora vale para qualquer lane. Jobs sem submissão não
-- deduplicam (NULL não conflita).
CREATE UNIQUE INDEX jobs_active_dedup_idx ON jobs (type, submission_id)
    WHERE status IN ('pending', 'running') AND submission_id IS NOT NULL;

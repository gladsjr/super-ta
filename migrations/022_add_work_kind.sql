-- Tipo do trabalho: 'interview' (entrevista clássica, uni-interação — o caminho
-- legado, intocado) ou 'scenario' (multi-interação, dirigido pelo estúdio de
-- cenários ligado ao trabalho via scenarios.work_id). Coexistência: os dois
-- mundos seguem separados no banco; a flag distingue um do outro na listagem do
-- admin e no roteamento. DEFAULT 'interview' backfilla os trabalhos existentes
-- como legado (não-destrutivo); trabalhos novos gravam 'scenario' na criação.
ALTER TABLE works ADD COLUMN kind TEXT NOT NULL DEFAULT 'interview' CHECK (kind IN ('interview','scenario'));

-- Configuração operacional mutável em runtime, editada na tela de Operações do
-- admin (issue #263). Chave-valor JSONB genérico: hoje só 'proctor_concurrency'
-- (nº de análises de vídeo em paralelo, default 1 — ver lib/proctorQueue.js).
-- Racional: precisa sobreviver a restart e propagar por Publish (tabela nova é o
-- caso que o diff dev→prod trata sem pegadinha); env var não serve porque o
-- ajuste é operacional, sem redeploy.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

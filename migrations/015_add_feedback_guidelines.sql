-- Configurações de devolutiva por TRABALHO (valem para o lote inteiro):
-- - feedback_guidelines: diretrizes do professor para a geração (tom,
--   formato, ênfases). NULL = default do agente.
-- - include_interviewer_opinion: default do trabalho para incluir a opinião
--   do entrevistador; os lotes propagam para as submissões tocadas (ajuste
--   fino por aluno continua em submissions.include_interviewer_opinion).
ALTER TABLE works ADD COLUMN feedback_guidelines TEXT;
ALTER TABLE works ADD COLUMN include_interviewer_opinion BOOLEAN NOT NULL DEFAULT TRUE;

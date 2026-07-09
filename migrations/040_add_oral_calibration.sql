-- Teste de calibração de fala da prova oral (pré-voz).
--
-- works.oral_calibration_json: a frase-alvo que o aluno repete no pré-teste de
--   captação, com os termos do domínio a checar — { sentence, key_terms }.
--   Gerada dos enunciados/respostas (OralCalibrationAgent) e editável pelo
--   professor. NULL/ausente = pré-teste DESLIGADO para o trabalho (fail-open).
--
-- submissions.oral_calibration_json: resultado do pré-teste daquele aluno —
--   { passed, attempts, worst_wer, missed_terms, target, transcripts }.
--   Alimenta o alerta de "calibração de fala" no painel do professor.
ALTER TABLE works ADD COLUMN oral_calibration_json JSONB;
ALTER TABLE submissions ADD COLUMN oral_calibration_json JSONB;

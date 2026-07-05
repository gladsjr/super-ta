-- Critério fixo de penalidade por alertas (proctoring na oral / autoria na
-- entrevista), aplicado APÓS o cálculo da nota pela rubrica. Opt-in por trabalho:
-- { enabled: bool, prompt: text }. NULL/ausente = desligado (comportamento atual).
-- Coluna compartilhada pelos dois kinds (interview e oral_realtime).
ALTER TABLE works ADD COLUMN grade_penalty_json JSONB;

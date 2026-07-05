-- Modo de pontuação da prova oral, por prova (works):
--   'deterministico' — o 2º campo da questão é a RESPOSTA ESPERADA; o avaliador
--     classifica correta/parcial/incorreta (mapeado a 10/5/0) e faz média
--     ponderada pelos pesos das questões.
--   'rubrica' — o 2º campo é o CRITÉRIO de pontuação; o avaliador dá um score
--     0–10 por questão aplicando o critério, e faz média ponderada.
-- Antes desta mudança a nota oral era média simples, sem peso. Peso e o 2º campo
-- por questão vivem no JSONB works.oral_questions (schemaless — sem DDL).
ALTER TABLE works ADD COLUMN oral_grading_mode TEXT NOT NULL DEFAULT 'deterministico';

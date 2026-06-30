-- Prova oral (Realtime) como TIPO de trabalho, escolhido na criação do token.
-- `kind` discrimina o tipo: 'interview' (legado, default) ou 'oral_realtime'.
-- Para o tipo oral: o professor sobe um PDF de perguntas-e-respostas (exam_pdf);
-- um modelo rápido extrai as perguntas para oral_questions (JSONB:
-- [{ id, question, answer }]). As respostas ficam aqui no servidor (futura
-- avaliação) e NUNCA vão à sessão Realtime do navegador.
ALTER TABLE works ADD COLUMN kind TEXT NOT NULL DEFAULT 'interview';
ALTER TABLE works ADD CONSTRAINT works_kind_check CHECK (kind IN ('interview', 'oral_realtime'));
ALTER TABLE works ADD COLUMN exam_pdf BYTEA;
ALTER TABLE works ADD COLUMN exam_filename TEXT;
ALTER TABLE works ADD COLUMN oral_questions JSONB;

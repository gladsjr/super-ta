-- Contador monotônico de ids de questões da prova oral. IDs de oral_questions
-- passam a ser ESTÁVEIS (não mais posicionais): apagar uma questão não desloca os
-- ids das outras, então as notas por questão já gravadas (grades_json / oral_asked_json)
-- seguem alinhadas. Novos ids saem sempre acima do high-water mark (nunca reusa id
-- de questão apagada). Default 1; setOralQuestions corrige para max(id existente)+1.
ALTER TABLE works ADD COLUMN oral_next_qid INTEGER NOT NULL DEFAULT 1;

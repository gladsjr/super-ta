-- Notas por RUBRICA da entrevista. O professor define uma rubrica (N critérios,
-- cada um com nome, peso e um prompt) e o GradingAgent calcula a nota de cada
-- critério sobre a avaliação interna completa; a nota final é a média ponderada.
--
-- grading_rubric: { criteria: [{id,name,weight,prompt}] } serializado (TEXT, como
-- evaluation_json). NULL = trabalho usa o DEFAULT_RUBRIC do código (2 critérios).
-- A nota é mais uma SEÇÃO da devolutiva (paralelo a include_interviewer_opinion):
-- include_grade no work é o default que os lotes propagam; na submissão é o
-- toggle por aluno. Default FALSE: a devolutiva só leva nota se o professor optar.
-- grades_json: { criteria:[{id,name,weight,score,justification,manual}], final,
-- computed_at } — guarda o snapshot dos critérios usados, então a nota continua
-- legível mesmo se a rubrica do trabalho mudar depois. grade_final desnormalizado
-- para listagem/ordenação em /w/:t/info.
ALTER TABLE works ADD COLUMN grading_rubric TEXT;
ALTER TABLE works ADD COLUMN include_grade BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE submissions ADD COLUMN include_grade BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE submissions ADD COLUMN grades_json TEXT;
ALTER TABLE submissions ADD COLUMN grade_final NUMERIC(4,2);
ALTER TABLE submissions ADD COLUMN grades_at TIMESTAMPTZ;

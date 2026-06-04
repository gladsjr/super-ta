-- Número de perguntas planejadas da entrevista, agora configurável pelo professor.
-- Antes era fixo em código (lib/config.js INTERVIEW_QUESTION_COUNT = 10); passa a
-- viver por trabalho em works.question_count. Default 6, faixa válida 3..20.
-- O valor é materializado no plano (PrepBuilder.buildPlan) no /upload; entrevistas
-- já em andamento mantêm o plano com que começaram.
ALTER TABLE works ADD COLUMN question_count INT NOT NULL DEFAULT 6;
ALTER TABLE works ADD CONSTRAINT works_question_count_chk
  CHECK (question_count BETWEEN 3 AND 20);

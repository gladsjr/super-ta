-- Cache da avaliação da entrevista pelo InterviewEvaluatorAgent (perspectiva
-- do entrevistador, funcionalidade do professor). Gerada sob demanda na rota
-- /w/:workToken/submissions/:subToken/evaluation; regenerável com ?force=true.
ALTER TABLE submissions ADD COLUMN evaluation_json TEXT;
ALTER TABLE submissions ADD COLUMN evaluation_at TIMESTAMPTZ;

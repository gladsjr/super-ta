-- Prova oral: avaliação (relatório de comparação ao gabarito) + devolutiva
-- MANUAL do professor. A nota reusa grade_final, e a publicação reusa
-- evaluation_published_at (devolutiva) e grade_published_at (nota) — como na
-- entrevista. Aqui só acrescentamos o relatório e o texto manual da devolutiva.
ALTER TABLE submissions ADD COLUMN oral_eval_json JSONB;
ALTER TABLE submissions ADD COLUMN oral_devolutiva TEXT;

-- Edição da devolutiva pelo professor. A versão AUTOMÁTICA
-- (student_evaluation_json, migration 012) é preservada; a editada vive em
-- coluna própria. O aluno vê a editada quando existir, senão a automática.
ALTER TABLE submissions ADD COLUMN student_evaluation_edited_json TEXT;
ALTER TABLE submissions ADD COLUMN student_evaluation_edited_at TIMESTAMPTZ;

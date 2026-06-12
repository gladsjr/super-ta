-- Publicação da devolutiva ao aluno. A avaliação interna (evaluation_json,
-- migration 011) NUNCA é exposta ao aluno; o que se publica é uma versão
-- formativa gerada pelo StudentFeedbackAgent e cacheada aqui.
-- evaluation_published_at NULL = não visível ao aluno (despublicada).
ALTER TABLE submissions ADD COLUMN student_evaluation_json TEXT;
ALTER TABLE submissions ADD COLUMN student_evaluation_at TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN evaluation_published_at TIMESTAMPTZ;

-- Vínculo OPCIONAL da submissão com um aluno logado. Nullable: preserva
-- "submissão sem aluno" (fluxo por token de submissão, que não exige conta).
ALTER TABLE submissions ADD COLUMN student_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE submissions ADD COLUMN source          TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX submissions_student_idx ON submissions (student_user_id);

-- Entrevistas de teste: o professor pode marcar uma submission como "de teste"
-- no momento da criação. Entrevistas de teste podem ser abertas pelo próprio
-- professor (impersonando o aluno); as reais não expõem esse caminho.
-- Marcação é definida na criação e não muda depois (decisão de produto).
ALTER TABLE submissions ADD COLUMN is_test boolean NOT NULL DEFAULT false;

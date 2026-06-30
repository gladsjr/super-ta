-- Perguntas REALMENTE sorteadas/feitas a este aluno (subconjunto do gabarito),
-- gravadas pelo relay no início da sessão. A avaliação deve considerar só estas
-- — não todas as perguntas disponíveis (quando N < total, cada aluno recebe um
-- sorteio). [{id, question, answer}] na ordem aplicada.
ALTER TABLE submissions ADD COLUMN oral_asked_json JSONB;

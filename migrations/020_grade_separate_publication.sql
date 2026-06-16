-- Publicação da NOTA separada da devolutiva. A nota deixa de ser uma seção da
-- devolutiva (include_grade, migration 019) e vira um artefato publicável
-- próprio: o professor pode publicar a devolutiva (subjetiva), receber o
-- comentário do aluno e só depois calcular/publicar a nota — ou fazer tudo
-- junto. grade_published_at é independente de evaluation_published_at.
--
-- include_grade (works e submissions) sai de cena: a visibilidade da nota ao
-- aluno passa a ser controlada por grade_published_at, não por flag de seção.
ALTER TABLE submissions ADD COLUMN grade_published_at TIMESTAMPTZ;
ALTER TABLE works DROP COLUMN include_grade;
ALTER TABLE submissions DROP COLUMN include_grade;

-- Expectativa de "resposta de cabeça" (espontânea, sem IA/consulta) por
-- trabalho. Quando ligada, a persona comunica a expectativa na abertura e o
-- aluno vê o aviso nas instruções. Opt-in (default FALSE) para não mudar o
-- comportamento de trabalhos existentes. Fase 2/3 (medição e avaliação da
-- espontaneidade) leem a mesma flag.
ALTER TABLE works ADD COLUMN expect_spontaneous BOOLEAN NOT NULL DEFAULT FALSE;

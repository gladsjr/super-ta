-- Alinha a CHECK de works.question_count ao cap do código (PR #116 baixou o
-- máximo de 20 para 10 em lib/config.js; a CHECK da migration 010 ficou em 3..20).
-- Verificado antes de escrever: nenhum work no banco tem question_count > 10
-- (máximo existente: 8), então o aperto é seguro.
--
-- NOME NOVO de constraint (não reutilizar works_question_count_chk): o Publish
-- do Replit compara constraints POR NOME — redefinir uma CHECK mantendo o nome
-- não propaga para produção (caso real: migrations 022→029).

ALTER TABLE works DROP CONSTRAINT works_question_count_chk;
ALTER TABLE works ADD CONSTRAINT works_question_count_3_10_chk
  CHECK (question_count BETWEEN 3 AND 10);

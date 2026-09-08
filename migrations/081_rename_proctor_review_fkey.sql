-- Corretiva (#389): a FK de submissions.proctor_review → proctor_review_levels(key)
-- criada inline na 074 existe em dev (submissions_proctor_review_fkey) mas o
-- Publish do Replit NÃO a materializou em produção — medido pelo health check
-- em 07/09/2026: nenhuma FK sobre proctor_review em prod, com nome nenhum.
--
-- O diff do Publish compara constraint por NOME. Renomear (DROP + ADD com nome
-- novo e a mesma definição) faz o diff ver uma constraint nova e criá-la em
-- produção — mesma técnica do caso 022→029. Nome explícito, pela convenção de
-- migrations do AGENTS.md; o health check confere a partir daqui.
-- Alguns bancos de teste também não possuem a FK antiga.
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_proctor_review_fkey;
ALTER TABLE submissions ADD CONSTRAINT submissions_proctor_review_level_fkey
    FOREIGN KEY (proctor_review) REFERENCES proctor_review_levels(key);

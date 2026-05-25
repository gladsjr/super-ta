-- 005_drop_final_report.sql
-- Remove a coluna final_report_json. Era escrita pelo handler /finalize
-- legado (botão "Gerar avaliação"), removido junto com a camada de scoring
-- por rubrica (calculateRubricScores, evaluateMethodology, evaluateParameters,
-- generateFinalReport) e os agents ComprehensionEvaluatorAgent /
-- ClarificationEvaluatorAgent — todos código morto.
--
-- O status derivado da submission passa a ser apenas 'pending' (sem upload)
-- ou 'in_progress' (com upload/conversa). O conceito 'finalized' some.
-- Eventuais rows que tinham final_report_json populado revertem para
-- 'in_progress' (intencional).

-- IF EXISTS porque o banco de produção foi criado sem essa coluna
-- (provavelmente removida manualmente antes do regime de migrations).
-- Em dev a coluna já foi removida pela versão anterior desta migration,
-- então o IF EXISTS é seguro nos dois ambientes.
ALTER TABLE submissions DROP COLUMN IF EXISTS final_report_json;

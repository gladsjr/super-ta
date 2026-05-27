-- 008_add_work_active.sql
-- Flag para desativar um trabalho sem apagá-lo. Trabalho desativado mantém
-- todas as submissões, conversas e configurações intactas, mas alunos perdem
-- acesso aos endpoints /s/:t/* (devolve 403 via requireSubmissionToken). O
-- painel do professor continua acessível — assim ele pode reativar quando
-- quiser, ou revisar conversas de entrevistas já feitas.
--
-- Para apagar de verdade existe DELETE /admin/works/:workToken, que conta com
-- ON DELETE CASCADE em submissions e work_cost_events (migrations 001 e 003).

ALTER TABLE works
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

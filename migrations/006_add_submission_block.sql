-- 006_add_submission_block.sql
-- Adiciona a flag is_blocked em submissions. Bloqueio é uma pausa branda imposta
-- pelo professor: o aluno perde acesso aos endpoints /s/:t/* (start, upload,
-- chat, audio) com 403, mas o log da entrevista continua visível pelo professor
-- via /w/.../conversation. Liberar é só retornar a flag para false; a sessão
-- em memória, se houver, segue lá e o /start rehidrata normalmente.
--
-- DEFAULT false cuida do backfill: tudo que já existe nasce desbloqueado.

ALTER TABLE submissions
    ADD COLUMN is_blocked BOOLEAN NOT NULL DEFAULT false;

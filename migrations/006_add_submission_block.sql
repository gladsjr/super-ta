-- 006_add_submission_block.sql
-- Adiciona a flag is_blocked em submissions. Bloqueio é uma pausa branda imposta
-- pelo professor: o aluno perde acesso aos endpoints /s/:t/* (start, upload,
-- chat, audio) com 403, mas o log da entrevista continua visível pelo professor
-- via /w/.../conversation. Liberar é só retornar a flag para false; a sessão
-- em memória, se houver, segue lá e o /start rehidrata normalmente.
--
-- DEFAULT false cuida do backfill: tudo que já existe nasce desbloqueado.

-- IF NOT EXISTS porque em produção a coluna foi criada manualmente
-- antes de existir esta migration (fora do regime de migrations).
-- Em dev a coluna foi criada por uma versão anterior desta própria
-- migration, então o IF NOT EXISTS é seguro nos dois ambientes.
ALTER TABLE submissions
    ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

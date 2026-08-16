-- Retomada de sessão de voz exige liberação do professor (issue #260).
--
-- Uma queda no meio da prova/entrevista de voz produzia retomada AUTOMÁTICA e
-- silenciosa: nova parte de vídeo, linha do tempo fragmentada, professor sem
-- saber (caso 222b9f5ef8d6, 7 partes). Com a ADR 0005 (vídeo bloqueante), a
-- retomada passa a ser um ato explícito: o aluno fica pausado e o professor
-- libera — ou avalia individualmente o que já foi gravado.
--
-- `resume_allowed_at` é a liberação PENDENTE: o professor marca, a próxima
-- conexão de retomada a CONSOME (volta a NULL). Cada nova queda exige nova
-- liberação — é isso que impede a fragmentação sem fim.
ALTER TABLE submissions
    ADD COLUMN resume_allowed_at TIMESTAMPTZ;

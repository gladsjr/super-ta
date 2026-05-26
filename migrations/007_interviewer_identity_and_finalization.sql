-- 007_interviewer_identity_and_finalization.sql
--
-- Duas mudanças relacionadas:
--
-- 1. Identidade do entrevistador configurável pelo professor (works.*).
--    Quando ambas as colunas são NULL, mantém o comportamento atual de
--    sorteio aleatório via lib/personas.js. Quando preenchidas, /upload usa
--    como overrides do pickPersona().
--
-- 2. Finalização e comentário do aluno (submissions.*). Captura o momento
--    explícito em que a entrevista terminou e por qual razão (plano cumprido
--    automaticamente ou desistência manual), além de um comentário opcional
--    do aluno para o professor. Após finalização, os endpoints /chat,
--    /upload e /audio devolvem 410 — a entrevista é imutável.

ALTER TABLE works
    ADD COLUMN interviewer_name TEXT,
    ADD COLUMN interviewer_gender CHAR(1);

ALTER TABLE works
    ADD CONSTRAINT works_interviewer_gender_valid
    CHECK (interviewer_gender IS NULL OR interviewer_gender IN ('f', 'm'));

ALTER TABLE works
    ADD CONSTRAINT works_interviewer_identity_pair
    CHECK (
        (interviewer_name IS NULL AND interviewer_gender IS NULL)
        OR (interviewer_name IS NOT NULL AND interviewer_gender IS NOT NULL)
    );

ALTER TABLE submissions
    ADD COLUMN student_comment TEXT,
    ADD COLUMN completion_reason TEXT,
    ADD COLUMN completed_at TIMESTAMPTZ;

ALTER TABLE submissions
    ADD CONSTRAINT submissions_completion_reason_valid
    CHECK (completion_reason IS NULL OR completion_reason IN ('complete', 'give_up'));

ALTER TABLE submissions
    ADD CONSTRAINT submissions_completion_pair
    CHECK (
        (completion_reason IS NULL AND completed_at IS NULL)
        OR (completion_reason IS NOT NULL AND completed_at IS NOT NULL)
    );

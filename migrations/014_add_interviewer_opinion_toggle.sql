-- A devolutiva ao aluno passa a ter duas partes: a OPINIÃO DO ENTREVISTADOR
-- (resumo da impressão da persona; não editável — o professor só decide
-- incluir ou não) e a AVALIAÇÃO DO PROFESSOR (formativa, editável). Este
-- toggle controla a inclusão da primeira parte no que o aluno vê.
ALTER TABLE submissions ADD COLUMN include_interviewer_opinion BOOLEAN NOT NULL DEFAULT TRUE;

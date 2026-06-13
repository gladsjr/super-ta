-- Visibilidade por SEÇÃO da devolutiva ao aluno. O conteúdo continua sendo
-- gerado pelo StudentFeedbackAgent; estas flags só decidem o que o aluno vê,
-- por submissão (toggle instantâneo, sem regerar). Os campos no work são o
-- default que os lotes propagam às submissões tocadas — paralelo a
-- include_interviewer_opinion (migrations 014/015).
ALTER TABLE submissions ADD COLUMN include_strengths BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE submissions ADD COLUMN include_improvement_areas BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE submissions ADD COLUMN include_study_suggestions BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE works ADD COLUMN include_strengths BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE works ADD COLUMN include_improvement_areas BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE works ADD COLUMN include_study_suggestions BOOLEAN NOT NULL DEFAULT TRUE;

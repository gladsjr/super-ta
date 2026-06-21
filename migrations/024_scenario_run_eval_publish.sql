-- Cockpit do professor para CENÁRIOS: persistir a devolutiva no run e adicionar
-- as flags de publicação (devolutiva e nota, desacopladas), espelhando o que a
-- entrevista tem em `submissions`. Hoje `scenario_runs` já tem evaluation_json e
-- grades_json; a devolutiva era gerada sob demanda (não persistida) e não havia
-- publicação ao aluno.
ALTER TABLE scenario_runs
  ADD COLUMN devolutiva_json         JSONB,
  ADD COLUMN evaluation_published_at TIMESTAMPTZ,
  ADD COLUMN grade_published_at      TIMESTAMPTZ;

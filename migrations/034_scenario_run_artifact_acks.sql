-- Artefatos por interação: o aluno precisa confirmar que LEU o material da etapa
-- antes de responder. Guardamos o "li o material" por interação no run, em JSONB:
--   { "<interaction_id>": "<iso timestamp>" }
-- O artefato em si (PDF) fica na definição do cenário (interaction.artifact, no
-- JSONB de scenarios.data) — aqui só registramos o aceite do aluno.
ALTER TABLE scenario_runs ADD COLUMN artifact_acks JSONB;

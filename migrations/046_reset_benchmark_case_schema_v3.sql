-- Reinício autorizado: o schema v3 incorpora toda evidência ao enunciado ou ao
-- trabalho e torna explícita a relação entre pergunta, objetivo e estado.
TRUNCATE TABLE
  benchmark_generation_calls,
  benchmark_call_ledger,
  benchmark_consensus,
  benchmark_judgments,
  benchmark_model_outputs,
  benchmark_runs,
  benchmark_releases,
  benchmark_setup_versions,
  benchmark_setup_generations,
  benchmark_setup_drafts,
  benchmark_jury_versions
RESTART IDENTITY CASCADE;

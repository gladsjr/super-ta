---
name: Ledger: avaliação em lote fica fora dos custos por aluno
description: Eventos AGENT:InterviewEvaluator têm submission_id NULL; como atribuí-los e por que os "lifetime por aluno" subcontam
---

Regra: os custos por aluno que somamos com `GROUP BY submission_id` em `work_cost_events` NÃO incluem a avaliação interna (`AGENT:InterviewEvaluator`, ~US$ 0,10–0,20/aluno) nem outros lotes do painel do professor — esses eventos são gravados com `submission_id` NULL (só `work_id`).

**Why:** descoberto em 25/07/2026 ao investigar 6 eventos InterviewEvaluator órfãos à meia-noite; sem isso os relatórios de custo por entrevista subcontam ~10–20%.

**How to apply:**
- Atribuição: casar `work_cost_events.created_at` com `submissions.evaluation_at` (batem em ±1 s; o lote roda serial em ordem de id).
- O lote de avaliação (POST /w/:token/evaluations) é disparado pelo professor no painel, roda serial; elegibilidade = tem conversa (status != pending) e sem avaliação — NÃO exige entrevista concluída, então pode avaliar aluno no meio da entrevista; sem `force` o lote pula quem já tem avaliação (reavaliar exige force ou re-eval individual).
- Cache nos evals: 1º frio, demais compartilham só ~3,3k de prefixo — esperado, não é o miss anômalo.

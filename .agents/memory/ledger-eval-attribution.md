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

## Voz Realtime (prova oral): custo pré-26/07/2026 vive em linhas BACKFILL

Os eventos `AGENT:OralRealtime` gravados antes de 26/07/2026 têm `cost_usd = 0` (preço do modelo realtime ausente da tabela de preços; havia também cache contado em dobro). Fix: preço + fail-fast no boot + fórmula corrigida; um backfill admin (26/07 01h19) gravou linhas `BACKFILL:realtime-voice evt=NNNN` **com** `submission_id` (ao contrário dos evals em lote, que ficam NULL) e corrigiu `works.spent_usd`.

**How to apply:** para custo por prova oral, some todos os eventos da submission normalmente — os originais zerados não distorcem e o backfill carrega o valor real. Sessões novas pós-fix metram na própria linha `AGENT:OralRealtime` e NÃO ganham backfill; não estranhe a mistura das duas formas no mesmo work.

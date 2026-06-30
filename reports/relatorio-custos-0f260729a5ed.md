# Relatório de Custos — ORATIA

**Trabalho:** Mackenzie 06 (`0f260729a5ed`)
**Período:** 06–16/06/2026
**Ambiente:** Produção (`super-ta.replit.app`)
**Gerado em:** 25/06/2026

> Todos os valores de gasto **já estão com o cache de tokens descontado** — o sistema registra os tokens em cache numa tarifa reduzida e o custo armazenado já reflete isso. Não é preciso descontar nada manualmente.

---

## 1. Resumo geral

| Indicador | Valor |
|---|---|
| Gasto total | **US$ 77,02** |
| Orçamento do trabalho | US$ 100,00 (77% utilizado) |
| Envios (submissões) | 27 |
| Envios entrevistados (com custo) | 22 |
| Custo médio por entrevista | ~US$ 3,50 |
| Tokens de entrada (total) | 16.175.248 |
| — destes, em cache | 9.994.496 (≈ 62%) |
| Tokens de saída (total) | 631.621 |
| Caracteres de voz (TTS) | 168.786 |

---

## 2. Gasto por dia

| Dia | Envios | Gasto (US$) |
|---|---:|---:|
| 06/06 | 19 | 0,00 |
| 07/06 | 0 | 4,86 |
| 08/06 | 1 | 4,78 |
| 09/06 | 6 | 4,15 |
| 10/06 | 0 | **41,81** |
| 11/06 | 1 | 6,32 |
| 12/06 | 0 | 4,96 |
| 13/06 | 0 | 1,91 |
| 14/06 | 0 | 0,29 |
| 15/06 | 0 | 7,84 |
| 16/06 | 0 | 0,10 |
| **Total** | **27** | **77,02** |

> Observação: os envios se concentram no início (06–09/06), mas o gasto se espalha pelos dias seguintes — os alunos enviaram cedo e as entrevistas/processamentos aconteceram ao longo do período, com **pico em 10/06 (US$ 41,81)**.

---

## 3. Gasto por etapa

| Etapa | Gasto (US$) | % do total |
|---|---:|---:|
| 🟦 Durante a entrevista | 58,40 | 75,8% |
| 🟨 Pós-entrevista (avaliação + devolutiva + nota) | 11,75 | 15,2% |
| 🟩 Preparação (antes da entrevista) | 6,87 | 8,9% |
| **Total** | **77,02** | **100%** |

**Detalhe — Pós-entrevista (US$ 11,75):**

| Componente | Gasto (US$) |
|---|---:|
| Devolutiva ao aluno (StudentFeedback) | 6,35 |
| Avaliação interna (InterviewEvaluator) | 4,53 |
| Cálculo das notas (Grading) | 0,86 |

> O cálculo das notas em si custa muito pouco (US$ 0,86 — uma chamada por critério). O custo dessa etapa vem principalmente das **devolutivas** (texto longo e cuidadoso por aluno) e das **avaliações internas**.

---

## 4. Gasto por agente (detalhado)

| Agente / componente | Eventos | Gasto (US$) | % do total |
|---|---:|---:|---:|
| SuperOrchestrator (condução turno a turno) | 232 | 53,43 | 69,4% |
| StudentFeedback (devolutiva) | 145 | 6,35 | 8,2% |
| InterviewEvaluator (avaliação interna) | 25 | 4,53 | 5,9% |
| Voz / TTS | 365 | 4,22 | 5,5% |
| PrepBuilder · buildPlan (plano da entrevista) | 20 | 3,46 | 4,5% |
| PrepBuilder · analyzeWork (análise do trabalho) | 20 | 3,42 | 4,4% |
| Grading (notas) | 40 | 0,86 | 1,1% |
| Transcrição / STT | 283 | 0,54 | 0,7% |
| Introdução | 68 | 0,19 | 0,2% |
| Inteligibilidade de áudio | 11 | 0,02 | 0,0% |
| **Total** | **1.209** | **77,02** | **100%** |

---

## 5. Gasto por tipo de chamada

| Tipo | Eventos | Gasto (US$) |
|---|---:|---:|
| Raciocínio (LLM / responses) | 561 | 72,26 |
| Voz (TTS) | 365 | 4,22 |
| Transcrição (STT) | 283 | 0,54 |
| **Total** | **1.209** | **77,02** |

---

## 6. Notas metodológicas

- **Fonte:** tabela `work_cost_events` (banco de produção), agregada por dia, etapa, agente e tipo de chamada. Total confere com `works.spent_usd` (US$ 77,02).
- **Cache:** o custo de cada evento já abate os tokens em cache (cobrados na tarifa `input_cached_per_mtok`). Cerca de **62% dos tokens de entrada de raciocínio foram cache hits**, reduzindo bastante a conta.
- **Maior alavanca de custo:** a entrevista em si (SuperOrchestrator, ~69% do total). É onde uma eventual otimização teria maior impacto.

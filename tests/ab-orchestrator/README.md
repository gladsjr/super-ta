# A/B do super-orquestrador — modelo rápido vs. forte (modo texto)

Mede se a **qualidade das perguntas e follow-ups** do `SuperOrchestratorAgent`
degrada ao trocar o modelo forte (`principal_reasoning_model`, hoje `gpt-5.5`)
pelo rápido (`fast_model`, hoje `gpt-5.4-mini`), e quanto se economiza em
**custo** e **tempo de resposta**.

Auto-contido: **só precisa de `OPENAI_API_KEY`**. Não sobe servidor HTTP, não
toca no Postgres, não usa PDFs reais (gera PDFs sintéticos). Não altera nenhuma
fiação de produção — instancia o orquestrador com o modelo de cada braço
diretamente.

> **Resultados já levantados** (modelo × esforço de raciocínio, com glossário dos
> termos e os números) estão em
> [`docs/historico/super-orchestrator-model-experiments.md`](../../docs/historico/super-orchestrator-model-experiments.md).

## Como rodar

```bash
# .env com OPENAI_API_KEY já é carregado por dotenv (como nos outros harnesses)
node -r dotenv/config tests/ab-orchestrator/run.mjs
```

Saída em `tests/ab-orchestrator/out/<timestamp>/`:
- `summary.md` — veredito (também impresso no terminal),
- `transcripts/*.md` — toda entrevista dos dois braços,
- `raw.json` — números crus para reanálise.

### Parâmetros (env, todos opcionais)

| var | default | efeito |
|---|---|---|
| `AB_REPEATS` | `2` | repetições por persona (3 personas × 2 = 6 entrevistas/braço) |
| `AB_QUESTION_COUNT` | `6` | tamanho do plano (define os guardrails min/max de turno) |
| `AB_MAX_STUDENT_TURNS` | `24` | corte de segurança por entrevista |
| `AB_PERSONAS` | `preparado,adversarial,fraco` | subconjunto de personas |
| `AB_PRINCIPAL_MODEL` | policy.yaml | sobrescreve o modelo forte |
| `AB_FAST_MODEL` | policy.yaml | sobrescreve o modelo rápido |
| `AB_PRINCIPAL_EFFORT` | default da API | `reasoning.effort` do braço forte (`minimal\|low\|medium\|high`) |
| `AB_FAST_EFFORT` | default da API | `reasoning.effort` do braço rápido (`minimal\|low\|medium\|high`) |
| `AB_JUDGE_MODEL` | = forte | modelo do juiz |
| `AB_SKIP_JUDGE` | — | pula o juiz (só custo/latência + transcrições) |

Para um smoke barato: `AB_REPEATS=1 AB_PERSONAS=preparado node -r dotenv/config tests/ab-orchestrator/run.mjs`.

## Desenho do experimento

**Variável isolada:** só o modelo do super-orquestrador muda entre braços. A
prep (`analyzeWork` + `buildPlan`) roda **uma vez no modelo forte** e o
`work_analysis` + plano são **compartilhados** pelos dois braços, então as
condições iniciais são idênticas. O aluno simulado também é fixo (`fast_model`)
nos dois braços — ele não está sob teste.

Dois sinais de qualidade complementares (a opção "os dois"):

1. **Pareado por turno (counterfactual).** O braço forte conduz a conversa e, a
   cada turno, o modelo rápido é avaliado no **mesmo estado congelado** (mesma
   history, mesmo `turnLog`, mesma `memory`), numa conversa-sombra efêmera. O
   juiz compara, às cegas, qual das duas próximas ações é melhor. Remove a
   divergência de conversa → sinal forte e direto sobre qualidade de
   pergunta/follow-up sob contexto idêntico.
2. **Holístico por entrevista.** Cada braço conduz entrevistas completas e
   independentes (o rápido constrói a própria `memory` e dirige a própria
   conversa). O juiz lê os dois transcripts (anonimizados, ordem randomizada) e
   pontua a condução geral por dimensão (1–5).

**Rubrica de qualidade** (em `judge.mjs`): relevância/profundidade; follow-up só
quando há lacuna real; captura de contradições internas; fidelidade à persona
(cliente decisor, não avaliador acadêmico); respeito ao princípio da "resposta
formulável de cabeça" (não exigir recálculo de VPL/TIR ao vivo); naturalidade.

**Custo e tempo:** cada chamada à OpenAI do orquestrador é instrumentada
(tokens via `computeResponsesCost` de `lib/billing.js`; latência de parede). O
`summary.md` reporta `$/entrevista` e latência p50/p95 por turno em cada braço,
mais a economia % e o speedup do rápido.

## Fixtures

`fixtures.mjs` gera um "estudo de viabilidade" sintético com números concretos e
**contradições internas plantadas** (taxa 10% vs 14%; recomenda Opção A mas a
tabela favorece a B; promete 3 cenários e entrega 2; ignora a troca do inversor
pedida pelo cliente). Isso dá material para o orquestrador exercitar perguntas,
follow-ups e verificação de contradições — exatamente o que o A/B mede. A persona
do entrevistador é a `Business Owner` (a mesma dos harnesses de texto existentes).

## Limitações

- Aluno simulado ≠ aluno real; o sinal é comparativo entre braços, não absoluto.
- Trabalho sintético; para máxima representatividade, troque as fixtures por um
  trabalho real (basta alimentar os buffers de PDF em `run.mjs`).
- O counterfactual avalia o rápido sempre sobre a `memory` construída pelo forte;
  o braço holístico cobre o rápido construindo a própria memória ao longo da
  conversa. Os dois juntos cobrem qualidade por-turno e cumulativa.

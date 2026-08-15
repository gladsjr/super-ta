# Investigação: GPT-5.6 no ORATIA

Data: 11/jul/2026.

Fontes oficiais consultadas:
- Modelos: https://developers.openai.com/api/docs/models
- Guia de migração/uso GPT-5.6: https://developers.openai.com/api/docs/guides/latest-model
- Preços: https://developers.openai.com/api/docs/pricing
- Raciocínio: https://developers.openai.com/api/docs/guides/reasoning
- Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching

## Resumo executivo

Os modelos existem oficialmente: `gpt-5.6-sol`, `gpt-5.6-terra` e `gpt-5.6-luna`.
O alias `gpt-5.6` aponta para `gpt-5.6-sol`; portanto, para economizar, o ORATIA
deve usar slug explícito, não o alias.

Na tabela Standard de contexto curto:

| Modelo | input/Mtok | cache read/Mtok | cache write/Mtok | output/Mtok | leitura prática |
|---|---:|---:|---:|---:|---|
| `gpt-5.6-sol` | 5.00 | 0.50 | 6.25 | 30.00 | mesmo preço nominal do `gpt-5.5` |
| `gpt-5.6-terra` | 2.50 | 0.25 | 3.125 | 15.00 | mesmo preço nominal do `gpt-5.4` |
| `gpt-5.6-luna` | 1.00 | 0.10 | 1.25 | 6.00 | 20% do `gpt-5.5`; 40% do `gpt-5.4` |
| `gpt-5.5` | 5.00 | 0.50 | - | 30.00 | referência antiga |
| `gpt-5.4` | 2.50 | 0.25 | - | 15.00 | configuração atual principal |

Correção da hipótese inicial: `gpt-5.6-luna` não custa metade do `gpt-5.5`; custa
um quinto do `gpt-5.5` em input/output Standard curto. O modelo que equivale à
metade do `gpt-5.5` é o `gpt-5.6-terra`.

## Impacto de implementação

Baixo para uma PoC e moderado para produção.

O ORATIA já usa a Responses API e passa o modelo por `config/policy.yaml`, então
a troca de modelo não exige mudar a superfície da API. Os pontos necessários são:

- Adicionar os slugs 5.6 em `config/pricing.yaml`; sem isso o boot falha por
  `validatePricingCoverage`.
- Contabilizar `usage.input_tokens_details.cache_write_tokens`, porque a família
  5.6 cobra escrita em cache. Sem esse ajuste, a medição local subestima custo.
- Ampliar a validação de `reasoning.effort`: GPT-5.6 suporta `none`, `low`,
  `medium`, `high`, `xhigh` e `max`. Mantive `minimal` para compatibilidade com
  modelos anteriores.
- Evitar `principal_reasoning_model: "gpt-5.6"` se o objetivo for custo, porque
  esse alias roteia para `gpt-5.6-sol`.
- Para auditoria completa em produção, vale criar uma migration futura adicionando
  `cache_write_tokens` em `work_cost_events`. O custo já pode ser calculado
  corretamente sem a coluna, mas o ledger não expõe a decomposição.

Arquivos ajustados nesta investigação:
- `config/pricing.yaml`
- `lib/billing.js`
- `lib/config.js`
- `agents/SuperOrchestratorAgent.js`
- `tests/ab-orchestrator/instrument.mjs`

Não alterei `config/policy.yaml`; a produção local continua em `gpt-5.4` com
`principal_reasoning_effort: high`.

## PoC: entrevista em texto

Harness usado: `tests/ab-orchestrator/run.mjs`, com `AB_SKIP_JUDGE=1`, 1 persona
(`preparado`), 3 perguntas, sem servidor HTTP e sem Postgres.

### Run 1: `gpt-5.4/high` vs `gpt-5.6-luna/high`

Saída: `tests/ab-orchestrator/out/2026-07-11T14-39-06-424Z`.

| Métrica | `gpt-5.4/high` baseline | `gpt-5.6-luna/high` independente | `gpt-5.6-luna/high` counterfactual |
|---|---:|---:|---:|
| Chamadas | 8 | 4 | 8 |
| Custo total | 0.4724 | 0.0638 | 0.1806 |
| Latência p50 | 9.2 s | 9.6 s | 10.5 s |
| Latência p95 | 17.0 s | 11.7 s | 14.8 s |
| Turnos da entrevista | 8 | 4 | n/a |
| Follow-ups | 4 | 0 | n/a |

Leitura: em `high`, Luna reduziu custo, mas não melhorou p50 de latência no
counterfactual. A entrevista independente terminou muito mais curta e sem
follow-ups; isso é bom para tempo/custo, mas é um sinal de risco de qualidade,
porque o baseline explorou mais contradições.

### Run 2: `gpt-5.4/high` vs `gpt-5.6-luna/low`

Saída: `tests/ab-orchestrator/out/2026-07-11T14-43-57-922Z`.

| Métrica | `gpt-5.4/high` baseline | `gpt-5.6-luna/low` independente | `gpt-5.6-luna/low` counterfactual |
|---|---:|---:|---:|
| Chamadas | 7 | 4 | 7 |
| Custo total | 0.2853 | 0.0632 | 0.0985 |
| Latência p50 | 9.0 s | 4.6 s | 4.1 s |
| Latência p95 | 17.7 s | 4.9 s | 5.1 s |
| Turnos da entrevista | 7 | 4 | n/a |
| Follow-ups | 3 | 0 | n/a |

Leitura: `luna/low` trouxe a melhora de latência esperada, com p50 em torno de
4-5 s no smoke. O mesmo alerta de qualidade permanece: a entrevista independente
fechou sem follow-ups.

## Interpretação

Para custo puro, `gpt-5.6-luna` é muito forte: mesmo considerando escrita de
cache, ficou entre 62% e 65% mais barato no counterfactual de mesmos estados, e
78% a 87% mais barato na entrevista independente curta.

Para tempo de resposta, o esforço importa mais que o slug:

- `luna/high`: custo cai, mas a latência p50 não melhorou contra `gpt-5.4/high`.
- `luna/low`: custo cai e a latência p50 caiu para cerca de metade no smoke.

Para qualidade, esta PoC não é conclusiva porque o juiz foi pulado. O sinal
qualitativo que exige cuidado é comportamental: Luna, especialmente no braço
independente, aceitou respostas e finalizou sem follow-ups. Como a tese central
do ORATIA é detectar contradições e fazer pressão oral produtiva, isso precisa
de avaliação com juiz antes de troca em produção.

## Recomendação

Próximo teste recomendado:

1. Rodar `gpt-5.4/high` vs `gpt-5.6-luna/low` com juiz habilitado, `AB_REPEATS=2`
   e personas `preparado,adversarial,fraco`.
2. Se Luna perder em captura de contradições, testar `gpt-5.6-luna/medium` antes
   de abandonar Luna.
3. Testar `gpt-5.6-terra/low` como alternativa conservadora: custo nominal igual
   ao `gpt-5.4`, mas talvez melhor latência/qualidade na família 5.6.
4. Só depois considerar alterar `config/policy.yaml`.

Minha recomendação provisória: não trocar o modelo principal de produção ainda.
O melhor candidato para nova rodada é `gpt-5.6-luna` com `reasoning.effort: low`,
porque foi o único que entregou simultaneamente custo e latência na PoC. A troca
fica condicionada a um A/B com juiz que confirme captura de contradições e
follow-ups apropriados.

## A/B com juiz: `gpt-5.4/high` vs `gpt-5.6-luna/low`

Run: `tests/ab-orchestrator/out/2026-07-11T15-54-19-809Z`.

Configuração:
- Baseline: `gpt-5.4` com `reasoning.effort: high`.
- Candidato: `gpt-5.6-luna` com `reasoning.effort: low`.
- Juiz: `gpt-5.4`.
- Amostra: 6 entrevistas por braço, 3 personas (`preparado`, `adversarial`,
  `fraco`) x 2 repetições, plano de 6 perguntas.
- Custo total do experimento: US$ 5.6717.

### Custo e latência

| Métrica | `gpt-5.4/high` | `gpt-5.6-luna/low` |
|---|---:|---:|
| Chamadas conduzindo entrevista | 54 | 48 |
| Custo total conduzindo entrevista | US$ 2.6311 | US$ 0.7675 |
| Custo por entrevista | US$ 0.4385 | US$ 0.1279 |
| Latência p50 por turno | 9.54 s | 4.49 s |
| Latência p95 por turno | 15.04 s | 7.57 s |

Economia do candidato: 70.8% por entrevista. Speedup p50: 2.13x.

### Qualidade pareada por turno

Mesmo contexto congelado, 54 turnos julgados:

| Resultado | Percentual | Contagem |
|---|---:|---:|
| Vence `gpt-5.4/high` | 33.3% | 18 |
| Vence `gpt-5.6-luna/low` | 63.0% | 34 |
| Empate | 3.7% | 2 |

Por dimensão:

| Dimensão | `gpt-5.4/high` | `gpt-5.6-luna/low` | Empate |
|---|---:|---:|---:|
| Relevância | 8 | 24 | 22 |
| Follow-up apropriado | 12 | 17 | 25 |
| Captura de contradições | 11 | 26 | 17 |
| Fidelidade à persona | 20 | 24 | 10 |
| Resposta de cabeça | 7 | 10 | 37 |

No pareado, o candidato venceu de forma clara. O sinal mais importante é captura
de contradições: 26 vitórias do Luna contra 11 do baseline, com 17 empates.

### Qualidade holística por entrevista

6 pares julgados:

| Resultado | Percentual | Contagem |
|---|---:|---:|
| Vence `gpt-5.4/high` | 83.3% | 5 |
| Vence `gpt-5.6-luna/low` | 16.7% | 1 |
| Empate | 0.0% | 0 |

Notas médias (1-5):

| Dimensão | `gpt-5.4/high` | `gpt-5.6-luna/low` |
|---|---:|---:|
| Relevância | 4.83 | 4.83 |
| Follow-up apropriado | 5.00 | 3.67 |
| Captura de contradições | 4.67 | 4.33 |
| Fidelidade à persona | 5.00 | 4.17 |
| Resposta de cabeça | 5.00 | 4.83 |

Leitura: o Luna ganhou a próxima ação no mesmo estado, mas perdeu a condução
acumulada da entrevista. A diferença aparece principalmente em follow-up
apropriado e fidelidade à persona. O candidato também fez menos turnos/follow-ups
nas entrevistas independentes: 48 chamadas contra 54 do baseline.

### Decisão provisória após o A/B

Não trocar produção ainda para `gpt-5.6-luna/low`.

O resultado é forte em custo e latência, e promissor no pareado por turno, mas o
holístico indica risco real de condução acumulada: menos follow-up, persona menos
consistente e perda em 5 de 6 entrevistas inteiras.

Próximos testes mais úteis:

1. Testar `gpt-5.6-luna/medium` contra `gpt-5.4/high` para ver se recupera
   condução holística mantendo boa parte da economia.
2. Testar `gpt-5.6-terra/low` como candidato conservador, porque tem preço base
   igual ao `gpt-5.4`, mas pode entregar melhor equilíbrio de latência/qualidade.
3. Criar um benchmark reproduzível e seguro antes de novas decisões de produção:
   dataset fixo, contradições conhecidas, outputs versionados, métricas estáveis
   e síntese automática comparável entre runs.

## A/B com juiz forte: `gpt-5.4/high` vs `gpt-5.6-luna/medium`

Run: `tests/ab-orchestrator/out/2026-07-11T17-37-56-115Z`.

Configuracao:
- Baseline: `gpt-5.4` com `reasoning.effort: high`.
- Candidato: `gpt-5.6-luna` com `reasoning.effort: medium`.
- Juiz: `gpt-5.6-sol` com `reasoning.effort: high`, cego e com ordem A/B
  randomizada.
- Amostra: 6 entrevistas por braco, 3 personas (`preparado`, `adversarial`,
  `fraco`) x 2 repeticoes, plano de 6 perguntas.
- Custo total do experimento: US$ 5.6289.

### Custo e latencia

| Metrica | `gpt-5.4/high` | `gpt-5.6-luna/medium` |
|---|---:|---:|
| Custo total conduzindo entrevista | US$ 2.6315 | US$ 0.7396 |
| Custo por entrevista | US$ 0.4386 | US$ 0.1233 |
| Latencia p50 por turno | 9.21 s | 4.64 s |
| Latencia p95 por turno | 17.79 s | 7.84 s |

Economia do candidato: 71.9% por entrevista. Speedup p50: 1.99x.

### Qualidade pareada por turno

Mesmo contexto congelado, 56 turnos julgados:

| Resultado | Percentual | Contagem |
|---|---:|---:|
| Vence `gpt-5.4/high` | 50.0% | 28 |
| Vence `gpt-5.6-luna/medium` | 46.4% | 26 |
| Empate | 3.6% | 2 |

Por dimensao:

| Dimensao | `gpt-5.4/high` | `gpt-5.6-luna/medium` | Empate |
|---|---:|---:|---:|
| Relevancia | 17 | 24 | 15 |
| Follow-up apropriado | 15 | 17 | 24 |
| Captura de contradicoes | 15 | 24 | 17 |
| Fidelidade a persona | 30 | 14 | 12 |
| Resposta de cabeca | 12 | 7 | 37 |

O pareado ficou praticamente empatado, com leve vantagem geral do baseline. O
sinal mais interessante e que o Luna venceu em relevancia e captura de
contradicoes, mas perdeu claramente em fidelidade a persona.

### Qualidade holistica por entrevista

6 pares julgados:

| Resultado | Percentual | Contagem |
|---|---:|---:|
| Vence `gpt-5.4/high` | 50.0% | 3 |
| Vence `gpt-5.6-luna/medium` | 50.0% | 3 |
| Empate | 0.0% | 0 |

Notas medias (1-5):

| Dimensao | `gpt-5.4/high` | `gpt-5.6-luna/medium` |
|---|---:|---:|
| Relevancia | 5.00 | 5.00 |
| Follow-up apropriado | 4.50 | 4.33 |
| Captura de contradicoes | 4.83 | 4.50 |
| Fidelidade a persona | 4.67 | 5.00 |
| Resposta de cabeca | 5.00 | 5.00 |

Leitura: `luna/medium` recuperou quase todo o dano observado em `luna/low`. O
holistico saiu de 5 derrotas em 6 entrevistas para empate perfeito de 3 a 3,
mantendo reducao de custo proxima de 72% e latencia aproximadamente 2x melhor.
Ainda assim, nao ha dominancia de qualidade contra `gpt-5.4/high`; o resultado e
um empate operacional, nao uma vitoria clara.

### Decisao provisoria apos o A/B com juiz forte

Decisao de produto: adotar `gpt-5.6-luna/medium` como novo braco principal.

A leitura estritamente tecnica de qualidade foi "empate operacional". A leitura
de produto e mais forte: com reducao de custo de aproximadamente 72%, latencia
perto de 2x melhor e qualidade holistica empatada, `luna/medium` vence para o
ORATIA porque custo e tempo de resposta afetam diretamente adocao, escala e
experiencia do aluno.

O benchmark reproduzivel continua necessario, mas agora como mecanismo de
governanca para futuras trocas de modelo, nao como bloqueador da adocao do
`luna/medium`.

O proximo passo estrategico e criar o benchmark seguro prometido: casos fixos,
contradicoes conhecidas, rubrica versionada, juiz forte, custo registrado e
relatorio comparavel entre execucoes. Como teste adicional antes disso, o
candidato mais natural e `gpt-5.6-terra/low`, para medir se a familia 5.6 entrega
melhor equilibrio mantendo preco nominal parecido com o `gpt-5.4`.

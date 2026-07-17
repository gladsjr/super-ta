# ORATIA Bench: plano de implementacao

Data: 11/jul/2026.

## Estado da implementacao

Entregue em 11/jul/2026:

- nucleo `frozen-turn` executavel por CLI;
- adaptador OpenAI;
- cinco casos seed e dez estados congelados;
- ledger local, hashes, artefatos e relatorios JSON/Markdown;
- qualidade, custo e latencia calculados separadamente;
- randomizacao A/B reproduzivel por semente;
- persistencia Postgres para runs, respostas, julgamentos e chamadas;
- execucao assincrona, progresso, cancelamento e limite de custo;
- interface administrativa em `/benchmark` para configurar, acompanhar e
  auditar execucoes;
- migration `042_add_benchmark.sql`.
- adaptadores OpenAI, Anthropic, Gemini e xAI;
- custo exato da xAI e distincao entre custo exato, estimado e desconhecido;
- conselho multi-fornecedor com mediana, dispersao e sinalizacao de
  discordancia;
- RAG lexical comum, deterministico e auditavel para candidatos e juizes;
- intervalo de confianca por bootstrap agrupado por caso e teste de sinais;
- migrations `043_benchmark_consensus_and_cost_source.sql`.
- fluxo versionado com rascunhos, geracoes, versoes `S major.minor.build`,
  conselhos `J major.minor` e combinacoes imutaveis `S-J`;
- fixtures iniciais publicados como `S0.0.1`, conselho inicial `J0.1` e
  combinacao `S0.0.1-J0.1`;
- execucoes obrigatoriamente vinculadas a uma versao `S-J`, com casos
  congelados e alerta de avaliacao repetida;
- interface separada em Casos, Setup, Geracoes, Versoes, Conselhos,
  Execucoes e Resultados;
- migration `044_benchmark_version_workflow.sql`.

Ainda pendente:

- deliberacao entre juizes nos casos de alta discordancia;
- corpus amplo e setup formal `S1.C1`;
- reconciliacao com APIs administrativas de custo;
- metricas estatisticas adicionais para amostras maiores e comparacoes
  pareadas entre candidatos.

Este plano transforma o desenho conceitual do ORATIA Bench em um subsistema
implementavel no projeto atual. A proposta e manter o benchmark separado do fluxo
de producao, mas reaproveitar infraestrutura existente: Express, Postgres,
configuracao YAML, billing, clientes de modelo e interface estatica.

## Objetivo

Criar um benchmark versionado, auditavel e multi-fornecedor para avaliar modelos
como entrevistadores do ORATIA.

O benchmark deve responder:

- qual modelo produz melhores proximas falas de entrevista;
- em quais areas, personas e dificuldades ele melhora ou piora;
- quanto custa por turno, entrevista e rodada;
- qual latencia real por modelo e fornecedor;
- quais artefatos foram usados em cada execucao;
- qual conselho de juizes julgou cada resultado;
- se a decisao e robusta ou depende de um juiz/modelo especifico.

## Principios de implementacao

1. Separar benchmark de producao.
2. Versionar corpus, contexto e juizes.
3. Guardar todos os artefatos de cada execucao.
4. Medir qualidade separada de custo e latencia.
5. Usar ledger local por chamada, com reconciliacao posterior quando possivel.
6. Permitir OpenAI, Anthropic, Gemini e Grok como juizes e candidatos.
7. Comecar pequeno, mas com schemas definitivos o bastante para crescer.

## Arquitetura proposta

Novos modulos:

- `lib/bench/`
  - `cases.js`: leitura e validacao dos casos.
  - `versions.js`: controle de versoes `S`, `C`, `J`.
  - `rag.js`: chunking, recuperacao e pacote de evidencias.
  - `adapters/`: adaptadores por fornecedor.
  - `candidateRunner.js`: executa modelo candidato nos estados congelados.
  - `judgeRunner.js`: executa conselho de juizes.
  - `consensus.js`: agrega votos e detecta discordancia.
  - `metrics.js`: calcula indices de qualidade, custo e latencia.
  - `ledger.js`: registra chamadas, uso, custo e latencia.
  - `reports.js`: gera resumo Markdown/JSON.
- `routes/benchmark.js`: API interna da interface.
- `static/benchmark/`: telas do painel.
- `scripts/bench-run.mjs`: execucao via linha de comando.
- `config/benchmark.yaml`: configuracao padrao do benchmark.
- `bench/`: corpus e artefatos versionados locais.

Diretorios de dados:

- `bench/cases/`: casos JSON com enunciado, trabalho, personas e plano.
- `bench/versions/`: manifestos `S/C/J`.
- `bench/runs/`: resultados completos de cada execucao.
- `bench/tmp/`: arquivos temporarios de execucao.

## Modelo de dados

### Tabelas principais

`benchmark_cases`

- `id`
- `case_key`
- `setup_version`
- `context_version`
- `area`
- `large_area`
- `course_level`
- `course_type`
- `difficulty`
- `persona_key`
- `source_hash`
- `metadata_json`
- `created_at`

`benchmark_turn_states`

- `id`
- `case_id`
- `turn_index`
- `state_json`
- `canonical_response`
- `expected_intent_json`
- `known_contradictions_json`

`benchmark_runs`

- `id`
- `run_key`
- `setup_version`
- `context_version`
- `jury_version`
- `mode`
- `status`
- `candidate_models_json`
- `judge_models_json`
- `config_json`
- `started_at`
- `finished_at`
- `created_by`

`benchmark_model_outputs`

- `id`
- `run_id`
- `case_id`
- `turn_state_id`
- `provider`
- `model`
- `model_role`
- `output_text`
- `output_json`
- `usage_json`
- `cost_estimated_usd`
- `cost_exact_usd`
- `latency_ms`
- `raw_response_json`
- `created_at`

`benchmark_judgments`

- `id`
- `run_id`
- `case_id`
- `turn_state_id`
- `candidate_output_id`
- `judge_provider`
- `judge_model`
- `phase`
- `score_general`
- `scores_json`
- `confidence`
- `flags_json`
- `rationale`
- `evidence_json`
- `raw_response_json`
- `latency_ms`
- `cost_estimated_usd`
- `created_at`

`benchmark_consensus`

- `id`
- `run_id`
- `case_id`
- `turn_state_id`
- `candidate_output_id`
- `score_general`
- `scores_json`
- `agreement_json`
- `needs_deliberation`
- `final_phase`

`benchmark_call_ledger`

- `id`
- `run_id`
- `provider`
- `model`
- `role`
- `case_id`
- `turn_state_id`
- `request_hash`
- `response_hash`
- `usage_json`
- `cost_estimated_usd`
- `cost_exact_usd`
- `cost_reconciled_usd`
- `latency_ms`
- `error_json`
- `created_at`

### Armazenamento de artefatos

Mesmo com Postgres, cada run deve ter um pacote em disco:

`bench/runs/<run_key>/`

- `manifest.json`
- `config.resolved.json`
- `cases/`
- `prompts/`
- `rag/`
- `outputs/`
- `judgments/`
- `ledger.jsonl`
- `metrics.json`
- `summary.md`
- `raw.json`

O banco serve para consulta rapida e interface. O pacote em disco serve para
auditoria, portabilidade e reproducao.

## Versionamento

Usar a forma:

`ORATIA-Bench Sx.Cy.Jz`

- `S`: corpus, entrevistas canonicas, estados congelados e documentos.
- `C`: contexto de avaliacao, personas, rubricas, prompts, schemas e politica
  de RAG.
- `J`: conselho de juizes, modelos, parametros e agregador.

Metadados extras para `S`:

- `setup_generation_jury`
- `setup_validation_jury`
- `human_reviewers`
- `generation_cost`
- `validation_cost`

Isso explicita que o setup tambem tem um conselho associado, possivelmente mais
barato ou diferente do conselho usado nas avaliacoes futuras.

## Provider adapters

Interface comum:

```js
export class ProviderAdapter {
  async generateInterviewTurn(request) {}
  async judgePair(request) {}
  async countTokens(request) {}
  extractUsage(response) {}
  estimateCost(usage, pricingVersion) {}
  getExactCost(response) {}
  capabilities() {}
}
```

Adaptadores iniciais:

- `OpenAIAdapter`
- `AnthropicAdapter`
- `GeminiAdapter`
- `XaiAdapter`

Capacidades registradas:

- structured output;
- reasoning effort;
- prompt caching;
- batch;
- token count;
- exact cost in response;
- admin usage/cost API;
- max context;
- timeout recomendado.

Quando uma capacidade nao existir, o harness registra `not_applicable` e segue
com alternativa controlada.

## Fluxo frozen-turn

1. Resolver configuracao do run.
2. Carregar manifestos `S/C/J`.
3. Selecionar casos.
4. Para cada caso e turno:
   - montar estado congelado;
   - recuperar evidencias por RAG;
   - chamar modelo candidato;
   - armazenar resposta e ledger;
   - montar pares anonimizados: canonico vs candidato;
   - chamar juizes independentes;
   - agregar consenso;
   - deliberar apenas se necessario;
   - armazenar votos e consenso.
5. Calcular metricas.
6. Gerar `summary.md`, `metrics.json` e dados para interface.

## Fluxo rollout

Implementar depois do frozen-turn.

1. O modelo candidato conduz a entrevista inteira.
2. Um simulador de persona responde.
3. O conselho avalia a trajetoria completa.
4. O resultado e marcado como complemento, nao substituto do frozen-turn.

O rollout mede acumulacao, insistencia, encerramento e consistencia. Ele e mais
caro e menos deterministico, entao nao deve ser o primeiro MVP.

## RAG

Implementacao inicial simples:

- extrair texto dos documentos;
- normalizar;
- chunkar por tamanho e secao;
- indexar com busca lexical;
- opcionalmente adicionar embeddings depois;
- recuperar top-k por pergunta/estado/rubrica;
- enviar o mesmo pacote de evidencias para todos os juizes;
- guardar chunks enviados.

Versao MVP pode usar busca lexical para reduzir dependencia. Embeddings entram
na fase 2 se a recuperacao lexical for insuficiente.

## Conselho e consenso

Fase independente:

- cada juiz avalia sem ver os demais;
- ordem A/B randomizada;
- resposta canonica e candidata anonimizadas;
- saida JSON validada.

Agregacao:

- mediana do score geral;
- mediana por dimensao;
- taxa de vitoria/empate/derrota;
- concordancia interjuizes;
- dispersao;
- confianca agregada.

Deliberacao condicional:

- executar apenas quando discordancia ultrapassar limiar;
- enviar argumentos anonimizados;
- permitir uma revisao por juiz;
- guardar votos antes e depois.

## Metricas

Qualidade:

- media, mediana e intervalo de confianca;
- taxa de vitoria, empate e derrota;
- vitorias claras;
- indices dimensionais;
- cortes por area, grande area, persona, dificuldade e nivel;
- falhas criticas;
- concordancia interjuizes;
- estabilidade entre repeticoes.

Custo:

- por chamada;
- por turno;
- por entrevista;
- por modelo;
- por fornecedor;
- por papel: candidato, juiz, setup, RAG;
- por 1.000 entrevistas simuladas;
- estimado vs exato vs reconciliado.

Latencia:

- p50, p90, p95, p99;
- por turno;
- por entrevista;
- por fornecedor;
- taxa de timeout;
- taxa de retry.

## Interface

Adicionar rota protegida:

- `GET /benchmark`
- `GET /api/benchmark/runs`
- `GET /api/benchmark/runs/:id`
- `GET /api/benchmark/runs/:id/artifacts`
- `POST /api/benchmark/runs`
- `POST /api/benchmark/runs/:id/cancel`
- `GET /api/benchmark/cases`
- `GET /api/benchmark/cases/:id`
- `GET /api/benchmark/versions`
- `GET /api/benchmark/providers`

Telas:

1. Runs
   - lista execucoes, status, versoes, modelos, custo, latencia e qualidade.
2. Run detail
   - resumo, cortes, intervalos, graficos e comparacoes.
3. Cases
   - documentos, persona, entrevista canonica, estados congelados.
4. Artifacts
   - prompts, evidencias RAG, respostas, votos, deliberacoes e erros.
5. Costs
   - custo por fornecedor, modelo, papel, caso e turno.
6. Latency
   - distribuicoes, timeouts, retries e outliers.
7. Config
   - criar run com modelos, juizes, amostra, concorrencia e limites de custo.
8. Versions
   - comparar `S`, `C` e `J`.

Configuravel sem reprogramar:

- modelo candidato;
- conselho de juizes;
- subconjunto de casos;
- modo frozen-turn;
- concorrencia;
- timeout;
- retries;
- limite maximo de custo;
- deliberacao ligada/desligada;
- limiar de discordancia.

Exige nova versao formal:

- corpus;
- personas;
- rubricas;
- prompts de julgamento;
- schemas;
- politica de RAG;
- agregador de consenso.

## Linha de comando

Comando inicial:

```bash
node -r dotenv/config scripts/bench-run.mjs \
  --benchmark ORATIA-Bench \
  --setup S1 \
  --context C1 \
  --jury J1 \
  --candidate openai:gpt-5.6-luna:medium \
  --cases sample-30 \
  --mode frozen-turn \
  --max-cost-usd 50
```

Tambem deve aceitar arquivo:

```bash
node -r dotenv/config scripts/bench-run.mjs --config config/benchmark.yaml
```

## Configuracao

`config/benchmark.yaml`:

```yaml
default_mode: frozen-turn
storage:
  runs_dir: bench/runs
limits:
  max_cost_usd: 50
  max_concurrency: 4
  timeout_ms: 90000
  retries: 2
rag:
  strategy: lexical
  top_k: 8
consensus:
  tie_threshold: 0.15
  deliberation_enabled: true
  deliberation_disagreement_threshold: 0.65
providers:
  openai:
    enabled: true
  anthropic:
    enabled: false
  gemini:
    enabled: false
  xai:
    enabled: false
```

## Fases

### Fase 0: consolidacao do A/B atual

Prazo estimado: 1 a 2 dias.

- transformar o harness `tests/ab-orchestrator` em referencia de metricas;
- documentar decisoes ja tomadas;
- garantir que `gpt-5.6-luna/medium` esta registrado como vencedor de produto;
- separar claramente experimento ad hoc de benchmark permanente.

Entregaveis:

- docs atualizados;
- checklist de lacunas do harness atual.

### Fase 1: nucleo do benchmark

Prazo estimado: 4 a 7 dias.

- criar `lib/bench`;
- criar schemas de caso, turno, run e julgamento;
- criar `scripts/bench-run.mjs`;
- implementar `OpenAIAdapter`;
- implementar ledger local;
- implementar frozen-turn sem interface;
- gerar `summary.md`, `raw.json` e `metrics.json`.

Entregaveis:

- benchmark CLI funcional;
- 5 casos seed;
- uma rodada `5.4/high` vs `luna/medium`;
- juiz OpenAI unico.

### Fase 2: persistencia e artefatos

Prazo estimado: 3 a 5 dias.

- migrations Postgres;
- persistir runs, outputs, julgamentos e ledger;
- pacote completo em `bench/runs`;
- checkpoint atomico por resposta de candidato e julgamento;
- retomada idempotente a partir do checkpoint ou reimportacao de `raw.json`;
- hashes de documentos, prompts e respostas;
- relatorio reproduzivel por run.

Entregaveis:

- banco consultavel;
- runs auditaveis;
- export completo por execucao.

### Fase 3: interface MVP

Prazo estimado: 5 a 8 dias.

- rotas `routes/benchmark.js`;
- tela de runs;
- detalhe de run;
- visualizacao de casos;
- visualizacao de artefatos;
- custo e latencia por run.

Entregaveis:

- painel interno para leitura e auditoria;
- criacao simples de run pela interface.

### Fase 4: multi-fornecedor

Prazo estimado: 5 a 10 dias.

- `AnthropicAdapter`;
- `GeminiAdapter`;
- `XaiAdapter`;
- configuracao de chaves;
- normalizacao de uso/custo;
- validacao de JSON;
- tratamento de retries e falhas por fornecedor.

Entregaveis:

- conselho multi-fornecedor;
- custo comparavel;
- logs de falhas e capacidades.

### Fase 5: consenso robusto

Prazo estimado: 3 a 6 dias.

- mediana ponderada;
- concordancia interjuizes;
- deteccao de discordancia;
- deliberacao condicional;
- votos pre e pos-deliberacao;
- analise de sensibilidade por juiz.

Entregaveis:

- `J` versionado;
- relatorio de consenso;
- metricas de robustez.

### Fase 6: corpus amplo

Prazo estimado: continuo.

- criar 20 a 30 casos iniciais;
- expandir para 150 a 300 casos;
- cobrir areas e personas;
- revisar manualmente casos criticos;
- congelar `S1.C1`.

Entregaveis:

- `S1.C1` MVP;
- depois `S2.Cx` amplo.

### Fase 7: reconciliacao financeira

Prazo estimado: 3 a 6 dias apos ledger.

- integrar OpenAI Costs API;
- integrar Anthropic Usage/Cost quando chave/admin permitir;
- registrar custo exato da xAI quando presente no `usage`;
- preparar reconciliacao Google Cloud/Gemini;
- tela de diferenca estimado vs reconciliado.

Entregaveis:

- custos auditaveis;
- relatorio financeiro por run.

## Ordem recomendada

1. Fase 1, porque valida o nucleo sem interface.
2. Fase 2, porque auditoria vem antes de painel bonito.
3. Fase 3, para tornar o benchmark operavel.
4. Fase 4 e 5, para conselho completo.
5. Fase 6 em paralelo, porque corpus exige curadoria.
6. Fase 7 quando ja houver ledger estavel.

## Riscos

- Custo explodir com conselho multi-fornecedor.
  - Mitigacao: limites por run, amostra sentinela e deliberacao condicional.
- Juizes discordarem demais.
  - Mitigacao: medir discordancia, nao esconder; usar deliberacao so quando
    necessario.
- Corpus ficar enviesado.
  - Mitigacao: cortes por area/persona e revisao humana.
- Benchmark virar imitacao da entrevista canonica.
  - Mitigacao: permitir que candidato supere a canonica e usar metadados de
    intencao, nao comparacao literal.
- Interface permitir mudancas que quebram comparabilidade.
  - Mitigacao: separar configuracao de run de versionamento formal.
- Custos estimados divergirem do faturamento.
  - Mitigacao: ledger local + reconciliacao por fornecedor.

## Primeiro passo concreto

Implementar a Fase 1 com escopo fechado:

- `OpenAIAdapter`;
- juiz unico `gpt-5.6-sol/high`;
- candidatos `gpt-5.4/high` e `gpt-5.6-luna/medium`;
- 5 casos seed em texto;
- frozen-turn;
- ledger local;
- relatorio `summary.md`.

Esse primeiro passo transforma a conversa atual em um benchmark minimo
executavel, sem ainda pagar o custo de interface completa e multi-fornecedor.

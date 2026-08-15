# ORATIA Bench: plano conceitual

Data: 11/jul/2026.

## Decisoes de desenho

1. O benchmark nao deve misturar qualidade, custo e latencia em um unico indice.
   Qualidade deve ter varios indices proprios. Custo e latencia ficam como eixos
   independentes de decisao.
2. A entrevista canonica deve representar a persona do entrevistador antes de tudo. Ela nao e um
   gabarito rigido para imitacao literal; e uma referencia forte, acompanhada de
   metadados que explicam intencao pedagogica, pontos de pressao e contradicoes.
3. O conselho de sabios deve julgar de forma independente primeiro. Deliberacao
   entre modelos so deve ocorrer quando houver discordancia alta.
4. RAG deve ser implementado fora dos modelos, de modo provider-agnostic. Cada
   juiz recebe o mesmo pacote de evidencias recuperadas, com citacoes e versao
   armazenadas.
5. Cada execucao do benchmark deve ser totalmente auditavel: prompts, modelos,
   parametros, trabalhos, enunciados, chunks recuperados, respostas, votos,
   custos, latencias e versoes.

## Unidade central: caso

Um caso contem:

- area, grande area, nivel, tipo de curso e dificuldade;
- enunciado original;
- trabalho do aluno;
- persona do entrevistador;
- persona do aluno;
- pontos de investigacao;
- pergunta inicial literal;
- objetivos da entrevista;
- estados comportamentais do aluno ligados a fala que respondem;
- contradicoes conhecidas;
- pontos de verificacao por area;
- riscos de resposta indevida;
- entrevista canonica;
- estados congelados por turno;
- rubrica geral;
- rubrica especifica do caso.

A entrevista canonica deve ser representativa da persona. Se a persona e
evasiva, enroladora ou insegura, a entrevista boa deve mostrar isso. Os
metadados servem para que o juiz saiba quando uma pergunta aparentemente dura,
curta, insistente ou indireta esta cumprindo uma funcao pedagogica.

## Dois modos de avaliacao

### 1. Frozen-turn benchmark

Modo principal, mais barato e reproduzivel.

Para cada turno canonico:

1. O modelo candidato recebe todo o estado permitido ate aquele ponto.
2. Ele produz a proxima fala do entrevistador.
3. O conselho compara a fala candidata com a fala canonica.
4. O conselho pode dizer que a candidata e melhor que a canonica.

Vantagem: todo modelo e avaliado nos mesmos estados, sem contaminacao por
trajetorias diferentes.

Limitacao: mede qualidade local do proximo passo, nao mede totalmente a
conducao acumulada.

### 2. Rollout benchmark

Modo complementar, mais caro.

O modelo candidato conduz a entrevista inteira contra um simulador de persona ou
contra respostas pregravadas ramificadas. O conselho avalia a entrevista como
trajetoria completa.

Vantagem: mede acumulacao, insistencia, consistencia e fechamento.

Limitacao: e mais caro, menos deterministico e mais dificil de comparar.

## Conselho de sabios

Composicao inicial desejada:

- melhor modelo OpenAI disponivel;
- melhor modelo Anthropic disponivel;
- melhor modelo Gemini disponivel;
- melhor modelo Grok disponivel.

Cada juiz recebe o mesmo pacote:

- resumo do caso;
- enunciado e trabalho, ou trechos recuperados por RAG;
- persona;
- estado da entrevista;
- resposta canonica A;
- resposta candidata B;
- rubrica;
- instrucao para julgamento cego;
- schema de saida.

O julgamento deve retornar:

- score geral em escala de -1 a +1;
- scores dimensionais;
- confianca;
- justificativa curta;
- flags de risco;
- citacoes dos trechos usados.

## RAG dos juizes

Nao se deve depender de "RAG nativo" de cada fornecedor. O benchmark deve ter um
RAG proprio:

1. normalizar enunciados, trabalhos e anexos;
2. quebrar em chunks versionados;
3. criar embeddings ou indice lexical/hibrido;
4. recuperar os mesmos trechos para todos os juizes;
5. anexar os trechos ao prompt de julgamento;
6. armazenar os chunks enviados em cada julgamento.

Quando o documento couber no contexto com folga, o benchmark pode enviar o
documento inteiro e registrar isso. Quando nao couber, usa recuperacao. O ponto
critico e que todos os juizes devem ver a mesma evidencia.

## Indices de qualidade

Nao ha indice unico obrigatorio. O relatorio deve trazer uma familia de metricas.

### Indices globais

- media do score geral;
- mediana do score geral;
- taxa de vitoria, empate e derrota;
- taxa de vitorias claras;
- intervalo de confianca por bootstrap;
- dispersao entre casos;
- dispersao entre juizes.

### Indices dimensionais

- relevancia da proxima pergunta;
- captura de contradicoes;
- pressao oral produtiva;
- fidelidade a persona;
- adaptacao a area;
- eficiencia do turno;
- risco de dar resposta pronta;
- clareza e naturalidade;
- respeito ao nivel do aluno;
- capacidade de aprofundamento.

### Indices por corte

- por area;
- por grande area;
- por nivel;
- por tipo de curso;
- por persona;
- por dificuldade;
- por tamanho do trabalho;
- por densidade tecnica;
- por quantidade de contradicoes.

### Indices de risco

- taxa de falhas criticas;
- taxa de perda de contradicao conhecida;
- taxa de inducao indevida;
- taxa de resposta de cabeca;
- taxa de encerramento prematuro;
- taxa de pergunta generica demais.

### Indices de robustez

- sensibilidade a juiz;
- sensibilidade a area;
- sensibilidade a persona;
- concordancia interjuizes;
- delta pre e pos-deliberacao;
- estabilidade entre repeticoes.

## Custo e latencia

Custo e latencia ficam fora do indice de qualidade.

Metricas obrigatorias:

- custo por turno;
- custo por entrevista;
- custo por 1.000 entrevistas;
- tokens de entrada, saida, cache read e cache write;
- latencia p50, p90, p95 e p99 por turno;
- tempo total por entrevista;
- taxa de timeout e erro;
- variancia de latencia.

A decisao de produto deve olhar a fronteira qualidade-custo-latencia, nao um
numero unico misturado.

## Contabilidade de custo

O benchmark deve ter contabilidade propria por chamada, mesmo quando o fornecedor
oferecer API de custos.

Motivo: APIs de custo tendem a ser agregadas por periodo, projeto, chave, modelo
ou usuario. Isso e excelente para reconciliacao financeira, mas nem sempre
substitui um ledger por turno, entrevista, caso, juiz e candidato.

Desenho recomendado:

1. registrar localmente toda chamada com `run_id`, `case_id`, `turn_id`,
   `provider`, `model`, `role` (`candidate`, `judge`, `setup`, `rag`), tokens,
   custo estimado, latencia e resposta bruta;
2. calcular custo estimado imediatamente a partir do `usage` da resposta e da
   tabela de precos versionada;
3. quando o fornecedor expuser custo exato por resposta, armazenar esse valor;
4. quando o fornecedor expuser API agregada de custos, reconciliar por janela de
   tempo, projeto, chave ou usuario;
5. mostrar no relatorio a diferenca entre custo estimado, custo exato por
   resposta quando existir e custo reconciliado.

Estado atual por fornecedor:

- OpenAI: ha Usage API e Costs API administrativas, boas para dashboards e
  reconciliacao agregada. Para custo por entrevista, ainda convem manter ledger
  local por chamada.
- Anthropic: ha Admin API com Usage and Cost API. Deve ser tratada como fonte de
  reconciliacao organizacional, mantendo ledger local para granularidade do
  benchmark.
- xAI/Grok: respostas de inferencia incluem custo exato no objeto `usage`, alem
  de endpoints de modelos com informacoes de preco. E um caso bom para custo
  exato por chamada.
- Gemini/Google: a billing oficial passa pelo ecossistema Google Cloud. O
  benchmark deve registrar `usageMetadata`/tokens e reconciliar com billing ou
  exportacao de custos quando configurado.

Para melhorar reconciliacao, cada fornecedor deve usar chave/projeto/workspace
separado para benchmark sempre que possivel. Isso reduz contaminacao com trafego
de producao.

## Fornecedores avaliados

O benchmark nao deve assumir que os modelos candidatos sao apenas OpenAI.

Deve haver uma camada `ProviderAdapter` com uma interface comum:

- `generateInterviewTurn`;
- `judgePair`;
- `countTokens` quando disponivel;
- `estimateCost`;
- `extractUsage`;
- `supportsStructuredOutput`;
- `supportsReasoningEffort`;
- `supportsPromptCaching`;
- `supportsBatch`.

Cada fornecedor implementa suas capacidades sem forcar paridade artificial. Se
um modelo nao tiver `reasoning.effort`, o benchmark registra `not_applicable`.
Se nao tiver JSON estrito confiavel, o harness faz validacao, reparo controlado
ou nova tentativa, sempre armazenando a falha.

Modelos de outros fornecedores podem entrar em dois papeis:

- como juizes do conselho;
- como candidatos a entrevistador.

Essa separacao e importante porque um modelo pode ser excelente juiz e ruim
entrevistador, ou vice-versa.

## Interface de gestao

O benchmark deve ter uma interface propria. A interface nao e so conveniencia:
ela e parte da governanca, porque permite auditar resultados e artefatos sem
abrir arquivos crus manualmente.

Telas recomendadas:

- `Runs`: listar execucoes, status, versoes `S-J`, modelos, custo, latencia e
  score de qualidade.
- `Run detail`: resumo executivo, intervalos de confianca, cortes por area,
  persona e dificuldade.
- `Cases`: navegar por enunciados, trabalhos, personas, planos e estados
  planejados do aluno.
- `Setup`: configurar a geracao e auditar entrevistas canonicas, incluindo os
  trechos recuperados por RAG em cada estado.
- `Artifacts`: ver prompts, chunks recuperados, respostas, votos individuais,
  deliberacoes, erros e repeticoes.
- `Judges`: comparar comportamento dos juizes, concordancia, vieses e mudancas
  pre/pos-deliberacao.
- `Costs`: custo por fornecedor, modelo, papel, caso, entrevista e turno.
- `Latency`: distribuicoes p50/p90/p95/p99, timeouts e variancia.
- `Config`: criar execucoes sem reprogramar, escolhendo modelos candidatos,
  conselho, amostra, cortes, concorrencia, limites de custo e politica de RAG.
- `Versions`: visualizar diferencas entre `S` e `J`, com hashes dos
  artefatos.

Configuracoes editaveis pela interface:

- modelos candidatos;
- modelos juizes;
- subconjunto de casos;
- tamanho da amostra;
- seeds;
- concorrencia;
- limites de custo;
- politica de retry;
- modo frozen-turn ou rollout;
- deliberacao ligada/desligada;
- limiar de discordancia para deliberacao.

Configuracoes que devem exigir nova versao formal, nao apenas clique:

- mudanca de corpus;
- mudanca de persona;
- mudanca de rubrica;
- mudanca de prompts de julgamento;
- mudanca de schema;
- mudanca de politica de RAG;
- mudanca do agregador de consenso.

## Versionamento

Uma versao completa separa:

- `S major.minor.build`: casos-fonte, personas, pontos de investigacao,
  objetivos, prompts, politica de RAG, entrevistas canonicas, estados
  congelados, propostas, votos e chamadas da geracao;
- `J major.minor`: conselho de juizes usado para avaliar candidatos.

Exemplo: `ORATIA-Bench S2.1.3-J2.1`.

## Armazenamento por execucao

Cada execucao deve guardar:

- hash e conteudo do enunciado e do trabalho;
- chunks e evidencias recuperadas;
- prompts completos;
- respostas completas;
- modelo, fornecedor, versao e parametros;
- seeds quando existirem;
- horarios;
- latencias;
- custos;
- erros e repeticoes;
- votos individuais;
- votos pos-deliberacao;
- agregacao final;
- relatorio gerado;
- codigo ou commit do harness.

Durante a execucao, `checkpoint.json` registra atomicamente cada resposta de
candidato e cada julgamento concluido. Em uma retomada, essas unidades sao
ignoradas e somente a unidade que estava em voo pode ser repetida. Ao final,
`raw.json` e o pacote de artefatos sao a fonte auditavel; as tabelas Postgres
sao uma projecao consultavel e podem ser reconstruidas sem novas chamadas aos
modelos.

## Plano incremental

### Fase 1: MVP metodologico

- 20 a 30 casos.
- 5 grandes areas.
- 4 personas.
- juiz OpenAI forte como baseline de julgamento.
- comparar `gpt-5.4/high` e `gpt-5.6-luna/medium`.
- validar schemas, armazenamento e relatorio.

### Fase 2: Conselho multi-fornecedor

- adicionar Anthropic, Gemini e Grok.
- implementar agregacao robusta.
- medir concordancia entre juizes.
- habilitar deliberacao apenas em discordancia alta.

### Fase 3: Corpus amplo

- 150 a 300 casos.
- cobertura de humanas, engenharias, administracao, economia, artes, computacao,
  saude, fisica, quimica, literatura e MBAs.
- cortes estatisticos por area, grande area, persona e dificuldade.

### Fase 4: Governanca continua

- benchmark completo para mudancas grandes;
- subconjunto sentinela para triagem rapida;
- golden set reservado;
- relatorios versionados;
- politica explicita para decidir quando atualizar `S`, `C` ou `J`.

# Experimentos de modelo/raciocínio do super-orquestrador

Registro dos testes A/B feitos para decidir **qual modelo e qual nível de
raciocínio** usar no `SuperOrchestratorAgent` (a chamada que conduz cada turno
da entrevista). Objetivo: saber quanto se ganha em **custo** e **tempo de
resposta** ao trocar o modelo forte por um mais barato/rápido, e quanto disso
custa em **qualidade** — principalmente na capacidade de pegar contradições do
aluno, que é a razão de existir da ferramenta.

Data dos runs: 11–12/jun/2026. Harness usado: `tests/ab-orchestrator/`.

> **Aviso de confiança estatística.** Os runs de triagem têm amostra pequena
> (3 entrevistas por configuração = "n=3"); o run inicial tem 6. São sinais
> **direcionais**, bons para decidir o que vale aprofundar — não são números
> finais. Diferenças de poucos pontos percentuais estão dentro do ruído.

---

## Glossário (leia antes das tabelas)

Os termos abaixo aparecem nos resultados. Sem isso, em pouco tempo ninguém
entende as tabelas.

- **Braço forte / baseline** — a configuração de referência (hoje em produção:
  modelo `gpt-5.5` no nível de raciocínio padrão). Tudo é medido contra ela.
- **Braço rápido / candidato** — a configuração mais barata/rápida sendo testada
  (ex.: `gpt-5.4`, ou `gpt-5.4-mini`, com este ou aquele nível de raciocínio).
- **Esforço de raciocínio (`reasoning effort`)** — quanto o modelo "pensa" antes
  de responder. Valores: `minimal` < `low` < `medium` < `high`. O **default da
  API é `medium`** — é o que produção usa hoje (o código não setava nada). Mais
  esforço = costuma melhorar qualidade, mas gera mais texto interno → **mais
  lento e um pouco mais caro**.
- **Pareado por turno** (também chamado "counterfactual") — comparação de
  qualidade no **mesmo ponto congelado da conversa**. No meio de uma entrevista,
  congela-se o estado (tudo que já foi dito + a resposta que o aluno acabou de
  dar) e pergunta-se às duas configurações: "a partir **daqui exatamente**, qual
  seria sua próxima fala?". Um juiz (outro modelo, às cegas) escolhe a melhor.
  Como as duas partem do ponto idêntico, a diferença é só do modelo, não de uma
  ter "pegado" uma conversa mais fácil. É o sinal mais limpo de "quem faz a
  melhor próxima pergunta".
- **Holístico por entrevista** — o oposto: cada configuração **conduz uma
  entrevista inteira sozinha**, do começo ao fim. No final, o juiz lê as duas
  entrevistas completas e diz qual foi melhor **no conjunto**. Mede a condução
  acumulada (o modelo se enrola ao longo do tempo? mantém o fio?).
- **Por que os dois** — pareado mede a qualidade de **cada jogada isolada**;
  holístico mede a **condução acumulada**. Pequenos déficits por jogada se
  somam: por isso é comum um modelo "empatar por turno" mas "perder a entrevista
  inteira".
- **Captura de contradições** — quantas vezes o entrevistador pegou uma
  incoerência do aluno (contra o próprio trabalho entregue ou contra algo que
  ele mesmo disse antes). É a dimensão mais importante para esta ferramenta.
- **Resposta formulável de cabeça** — princípio do sistema: numa conversa oral,
  o entrevistador **não** deve exigir que o aluno recalcule um número exato ao
  vivo (VPL, TIR etc.); aceitar direção + mecanismo + ordem de grandeza basta.
  "Exigência de recálculo" = violação desse princípio (menor é melhor).
- **Esquina combinada** — quando há dois eixos (modelo × esforço), pense numa
  tabela 2×2. Testar "só o modelo" ou "só o esforço" são as bordas; a **esquina
  combinada** é mexer nos dois ao mesmo tempo (ex.: modelo mais barato **e**
  raciocínio diferente juntos).
- **n / repetições** — quantas entrevistas por configuração. Mais = número mais
  confiável, menos ruído.

---

## Tabela de preços usada (de `config/pricing.yaml`)

Preço por milhão de tokens (USD). Esta tabela é **conservadora** (superestima o
custo; ver comentários no arquivo). A razão entre modelos é o que importa:

| Modelo | input | input cacheado | output |
|---|---|---|---|
| `gpt-5.5` | 5,00 | 2,50 | 30,00 |
| `gpt-5.4` | 2,50 | 1,25 | 15,00 |
| `gpt-5.4-mini` | 0,75 | 0,375 | 4,50 |

**`gpt-5.4` é exatamente metade do preço do `gpt-5.5` em todos os eixos.**

### De onde vem o custo de um turno (descoberta importante)
Quebrando o custo do braço forte (`gpt-5.5`) no run inicial:

- **input/contexto = ~84% do custo** (histórico relido a cada turno + busca nos
  PDFs). Cacheado ~52%, não-cacheado ~32%.
- **output (inclui o raciocínio interno) = só ~16%.**

Consequência prática: **baixar o nível de raciocínio corta pouco custo** (mexe
só nos 16% de output). Onde baixar raciocínio paga mesmo é em **velocidade**, não
em dinheiro. E o maior dreno de custo é o **contexto**, não o modelo nem o
esforço.

---

## De onde vem o tempo que o aluno espera (modo áudio)

Medição real contra a API (mesmas funções que o `/chat` usa). O tempo é serial:
transcrição da fala do aluno → raciocínio do orquestrador → geração da voz.

| Etapa | tempo medido (p50) |
|---|---|
| Transcrever a fala do aluno (STT, ~28s de áudio) | ~2,0 s |
| Gerar a voz do entrevistador (TTS, 1 pergunta) | ~2,9 s |
| **Áudio total (transcrição + voz)** | **~4,9 s** |
| Raciocínio do orquestrador — `gpt-5.5` | ~12,3 s |
| Raciocínio do orquestrador — `gpt-5.4-mini` | ~6,7 s |

**Conclusão: o raciocínio domina, não o áudio.** Com o `gpt-5.5`, o raciocínio é
~71% da espera; mesmo com um modelo rápido, ainda é a maior fatia (~58%). Para
acelerar a resposta visível ao aluno, o alvo é o **raciocínio** (trocar de
modelo, baixar esforço, ou tirar trabalho do caminho crítico), não o áudio.
(Observação: o aluno também sofre upload do áudio + buffering no navegador, que
é rede/cliente e não entra nessa conta.)

---

## Resultados dos A/B

Todos contra a âncora de produção `gpt-5.5` no esforço padrão (`medium`).

### Run inicial — `gpt-5.5` vs `gpt-5.4-mini` (n=6)
O modelo mini é muito mais barato, mas **degrada forte**:

| | custo/entrevista | velocidade (p50) | vence por turno | vence a entrevista inteira |
|---|---|---|---|---|
| `gpt-5.5` (produção) | $1,24 | 12,3 s | **84%** | 67% |
| `gpt-5.4-mini` | $0,18 | 6,7 s | 12% | 33% |

Economia 85,8%, ~1,8× mais rápido. Mas em captura de contradições o mini foi
atropelado (pegou 4 contra 36 do forte, no pareado). **Veredito: barato demais
custa caro em qualidade.**

### Run A — eixo modelo: `gpt-5.4` vs `gpt-5.5`, ambos esforço padrão (n=3)

| | custo/entrevista | velocidade (p50) | vence por turno | vence a entrevista | contradições (pareado) |
|---|---|---|---|---|---|
| `gpt-5.5` (produção) | $1,41 | 12,7 s | 63% | 100% | 14 |
| `gpt-5.4` | $0,56 | 5,6 s | 30% | 0% | 2 |

**−60,5% de custo, 2,28× mais rápido** — e sim, o `5.4` **é** mais rápido. Mas
perde qualidade de verdade, concentrada em relevância e captura de contradições.
Muito melhor que o mini, ainda assim atrás do `5.5`.

### Run B — eixo esforço: `gpt-5.5/low` vs `gpt-5.5/default` (n=3)

| | custo/entrevista | velocidade (p50) | vence por turno | vence a entrevista |
|---|---|---|---|---|
| `gpt-5.5` padrão (produção) | $1,18 | 12,9 s | 52% | 33% |
| `gpt-5.5` esforço baixo | $1,05 | 10,3 s | 43% | 33% |

**Baixar o esforço quase não mexeu na qualidade** (empate técnico, pareado e
holístico), mas também economizou pouco (−11%) e acelerou pouco (1,26×). Ou seja,
no modelo forte o esforço é um knob **fraco** — ele já está "saturado".

### Run C — esquina combinada: `gpt-5.4/high` vs `gpt-5.5/default` (n=3)
A ideia: compensar o modelo mais fraco **subindo** o raciocínio dele.

| | custo/entrevista | velocidade (p50) | vence por turno | vence a entrevista | contradições (pareado) |
|---|---|---|---|---|---|
| `gpt-5.5` padrão (produção) | $1,35 | 11,8 s | 46% | 67% | 10 |
| `gpt-5.4` esforço alto | $0,75 | 9,5 s | **50%** | 33% | 7 |

**Funcionou:** subir o raciocínio do `5.4` recuperou boa parte da qualidade.
Comparando com o Run A (mesmo modelo, esforço padrão), isolando só o efeito do
esforço sobre o `5.4`:

| `gpt-5.4` vs produção | esforço padrão (Run A) | esforço alto (Run C) |
|---|---|---|
| economia de custo | −60,5% | −44,5% |
| velocidade | 2,28× | 1,24× |
| vence por turno | 30% | 50% (empate técnico) |
| vence a entrevista | 0% | 33% |
| contradições (pareado, forte/cand.) | 14 / 2 | 10 / 7 |

O `5.4/high` ficou em **empate técnico por turno**, fechou quase todo o buraco de
contradições (14/2 → 10/7), continua **44,5% mais barato** e **ainda mais
rápido** que produção (não ficou mais lento). O preço foi consumir parte da
economia e da velocidade extras.

### Lição sobre o esforço de raciocínio
O knob de esforço é **fraco no `gpt-5.5`** (Run B: pouco efeito) e **forte no
`gpt-5.4`** (Run C: muito efeito). Faz sentido: o modelo forte já está saturado,
o mais fraco tem espaço para ganhar pensando mais. **Esforço não é um knob
universalmente útil — ele rende onde o modelo ainda não saturou.**

---

## Situação atual (jun/2026) e próximos passos

- **Candidato líder:** `gpt-5.4` com esforço de raciocínio **alto**. Mais barato
  e mais rápido que produção, com qualidade encostada por turno. Ainda perde de
  leve a entrevista inteira e em captura de contradições — **a confirmar com mais
  amostra**.
- **Pendente — medição absoluta:** todos os números acima são **comparativos**
  ("A vence B"). Falta medir em **absoluto**: de N contradições plantadas no
  trabalho sintético, quantas cada modelo **deixa passar**. Plano: um "boletim de
  detecção" que corrige cada entrevista contra um gabarito conhecido (as
  contradições estão enumeradas em `tests/ab-orchestrator/fixtures.mjs`).
- **Pendente — confirmação em amostra maior** (n=9+) do `5.4/high` antes de
  qualquer troca em produção.

### Nota de arquitetura (avaliada, não implementada)
Cogitou-se separar parte do trabalho do super-orquestrador num **agente paralelo
não-bloqueante** para acelerar a resposta. Conclusão da avaliação:

- Paralelismo **só** corta tempo se o trabalho sair do **caminho crítico**
  (assíncrono). Rodar em paralelo mas ainda esperando o resultado (como a frota
  de agentes antiga) não ajuda latência.
- O melhor candidato a separar é a **verificação de contradições via
  `file_search`** (blocos "VERIFICAÇÃO DE CONTRADIÇÕES" e "hint pergunta-sem-
  fonte" do prompt): é a única responsabilidade ao mesmo tempo **cara em
  latência** (força um round-trip de busca dentro da chamada) e **tolerante a
  atraso de um turno**.
- **Custo:** a flag de contradição chegaria um turno atrasada — risco na função-
  núcleo da ferramenta. Mitigação: checagem rasa/barata (palavra-chave) no
  caminho rápido + varredura profunda no agente de fundo.
- **Antes de construir:** medir quanto dos ~12s de latência por turno é o
  `file_search`. Se for pouco (1–2s), não compensa a complexidade. Ganhos de
  tempo mais baratos e sem dívida arquitetural: **pré-busca especulativa** no
  tempo morto (enquanto o aluno digita/fala) e **pipelining do TTS** (gerar a voz
  frase-a-frase em vez de um bloco só).

---

## Como reproduzir

O harness é auto-contido (só precisa de `OPENAI_API_KEY`, modo texto, PDFs
sintéticos). Ver `tests/ab-orchestrator/README.md`. Exemplos dos runs acima:

```bash
# Run A — modelo 5.4 vs 5.5
AB_REPEATS=1 AB_PRINCIPAL_MODEL=gpt-5.5 AB_FAST_MODEL=gpt-5.4 \
  npm run test:ab-orchestrator

# Run B — esforço baixo no 5.5
AB_REPEATS=1 AB_PRINCIPAL_MODEL=gpt-5.5 AB_FAST_MODEL=gpt-5.5 AB_FAST_EFFORT=low \
  npm run test:ab-orchestrator

# Run C — esquina combinada 5.4 com esforço alto
AB_REPEATS=1 AB_PRINCIPAL_MODEL=gpt-5.5 AB_FAST_MODEL=gpt-5.4 AB_FAST_EFFORT=high \
  npm run test:ab-orchestrator
```

O knob de esforço (`AB_PRINCIPAL_EFFORT` / `AB_FAST_EFFORT`) foi adicionado ao
harness e é **opt-in**: produção não passa nada, então o comportamento padrão da
API (= hoje) é preservado. Saída de cada run em
`tests/ab-orchestrator/out/<timestamp>/` (gitignored): `summary.md`, transcrições
e `raw.json`.

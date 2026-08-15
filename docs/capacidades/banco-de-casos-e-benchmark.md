# Banco de casos e benchmark

> **Estado:** em produção · revisado em 2026-08-15
> Usuário desta capacidade: **a equipe**. Produz evidência sobre o sistema, não
> sobre o aluno.

**Uma frase:** um banco de casos congelados e um mecanismo versionado que roda os
modelos contra eles, julga os resultados e permite comparar — inclusive entre
provedores diferentes e entre ambientes diferentes.

## Para que serve

Toda decisão de modelo do ORATIA é cara e irreversível na prática: o estilo do
entrevistador domina custo **e** nota, e trocar de modelo muda os dois de uma
vez. O benchmark existe para que essa decisão seja tomada com número, e não com
impressão — e para que a comparação continue válida seis meses depois, quando o
modelo de referência já mudou.

## As três coisas que ele versiona

O que faz este subsistema diferente de "rodar um teste" é que **tudo que afeta o
resultado é versionado**, e um resultado só é comparável a outro se as versões
baterem:

| Versão | O que congela |
|---|---|
| **Setup (S)** | O conjunto de casos, com um manifesto dos casos congelados naquela versão. |
| **Júri (J)** | Quem julga e com que critério. |
| **Release (S+J)** | O par setup + júri. É a unidade contra a qual um resultado tem sentido. |

Cada execução guarda seus filhos: as saídas dos modelos, os julgamentos, o
consenso entre juízes e o **ledger de custo** daquela rodada.

## O banco de casos

Cinco casos em `bench/cases/*.json`, deliberadamente espalhados por grande área,
área e nível de curso — Engenharias, Economia, Saúde, Administração e Computação.
Cada caso é autocontido e traz: persona do entrevistador, persona do aluno,
enunciado, trabalho do aluno, pontos de investigação, plano de entrevista e os
**estados possíveis do aluno** (como ele reage). Os arquivos carregam
`schema_version` própria — hoje na 3 — para que um caso antigo não seja lido com
as regras de um formato novo.

## Portabilidade entre ambientes

Os resultados vivem no Postgres local de quem rodou, mas **o que se está medindo
são os modelos, não o ambiente**. Por isso existe um pacote portátil de
exportação e importação, que leva versões de setup, de júri, releases e as
execuções completas com seus filhos. Colunas de identidade local — quem publicou,
qual chave gerou, qual diretório de artefato — são zeradas na importação, porque
não existem no destino. Ver
[ADR 0012](../decisoes/0012-resultados-de-benchmark-sao-portaveis.md).

Há adaptadores por provedor (hoje OpenAI e Anthropic), então o mesmo caso pode
ser rodado contra modelos de casas diferentes.

## Testes cegos "por fora"

Separado do benchmark automatizado, e complementar a ele: uma ferramenta exporta
transcrições de entrevistas reais em pastas com **rótulos cegos** — a mesma
conversa vira "modelo A" e "modelo B" sem que o avaliador saiba qual é qual. O
gabarito (rótulo → trabalho de origem) é gravado num arquivo à parte.

Os pacotes cegos são então entregues a **juízes independentes fora do sistema** —
outras IAs, ou humanos — com um prompt de avaliação padronizado. Foi assim que se
decidiu a troca de modelo em produção e que se reprovou um candidato duas vezes:
o veredito cego pegou uma fabricação de contradição numérica que a nota agregada
não pegava.

**Por que "por fora" importa:** o júri interno do benchmark compartilha família de
modelo com o que está sendo julgado. Um juiz externo e cego é a defesa contra o
sistema se autoavaliar bem.

## Como se usa

| Comando | O que faz |
|---|---|
| `npm run bench` | Roda o benchmark. |
| `npm run bench:validate` | Ensaio a seco: valida sem gastar token. |
| `npm run bench:export` / `bench:import` | Move resultados entre ambientes. |
| `npm run benchmark:work` | Cria um trabalho marcado como de benchmark. |
| `tests/export-transcripts.mjs` | Gera os pacotes de avaliação cega. |

Trabalhos de benchmark são marcados no banco e podem usar **chave de API
dedicada**, o que permite reconciliar o gasto medido com a fatura real do
provedor sem misturar com o uso de produção.

## O que esta capacidade NÃO faz

- **Não** prevê custo de produção. Bench congelado mede modelo em condição
  controlada; custo real depende de aluno real. Isso já foi medido e confirmado.
- **Não** substitui o veredito cego. O júri automático e o juiz externo medem
  coisas diferentes e ambos são necessários.
- **Não** roda em produção nem toca dados de aluno.
- **Não** garante comparabilidade entre releases diferentes: resultado só é
  comparável dentro do mesmo par setup + júri.

## Cenários

- **Dado** um resultado importado de outro ambiente, **quando** ele é aberto,
  **então** aparece sem os dados de identidade local do ambiente de origem.
- **Dado** um caso com `schema_version` antiga, **quando** o runner o carrega,
  **então** ele sabe qual formato está lendo.
- **Dado** dois modelos sob teste, **quando** as transcrições vão para avaliação
  cega, **então** o avaliador recebe rótulos neutros e o gabarito fica de fora
  do pacote.

## Referência técnica

`lib/bench/` — `runner`, `store`, `reports`, `portable`/`portableFormat`,
`orchestratorContract`, `prompts`, `adapters/{openai,anthropic}`.
`bench/cases/*.json`, `scripts/bench-*.mjs`, `tests/export-transcripts.mjs`.
Histórico dos experimentos que motivaram tudo isso:
[`docs/historico/`](../historico/README.md).

## Decisões relacionadas

- [ADR 0012 — Resultados de benchmark são portáveis entre ambientes](../decisoes/0012-resultados-de-benchmark-sao-portaveis.md)
- [ADR 0008 — Voz em tempo real não é mais barata](../decisoes/0008-voz-realtime-nao-e-mais-barata.md)

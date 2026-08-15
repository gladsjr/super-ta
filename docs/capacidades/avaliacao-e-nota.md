# Avaliação e nota

> **Estado:** em produção · revisado em 2026-08-15

**Uma frase:** depois da arguição, o sistema produz uma **leitura interna** do
desempenho (só para o professor) e uma **nota por rubrica** (sugerida, editável e
publicada à parte) — são coisas separadas de propósito.

## As três saídas, e por que são separadas

| Saída | Quem vê | Natureza |
|---|---|---|
| **Avaliação interna** | só o professor | Análise pergunta a pergunta: onde o aluno brilhou, onde vacilou, sinais de autoria. Nunca chega ao aluno. |
| **Nota por rubrica** | o aluno, se publicada | Cálculo pelos critérios e pesos do professor. Nasce como sugestão. |
| **[Devolutiva](devolutiva.md)** | o aluno, se publicada | Texto formativo, limpo de bastidores. **Em revisão.** |

A separação é deliberada: o que serve à decisão do professor não é o que serve ao
aprendizado do aluno, e publicar um não implica publicar o outro. O professor
pode, por exemplo, publicar a devolutiva primeiro, ler o comentário do aluno, e
só então publicar a nota.

## Como a nota é calculada

- **Nas entrevistas:** o professor define os critérios da rubrica; cada critério
  recebe uma nota de 0 a 10, e a final é a **média ponderada calculada em código**
  — não pelo modelo.
- **Na prova oral:** cada pergunta é um item de rubrica com peso próprio, e a
  nota de cada uma é ancorada em cinco níveis fixos (0 · 2,5 · 5 · 7,5 · 10). A
  nota da prova é a média ponderada.

A avaliação **recusa** perguntas sem rubrica em vez de improvisar um critério.

## O que esta capacidade NÃO faz

- **Não** publica nada sozinha. Nota e devolutiva só chegam ao aluno por ação
  explícita do professor.
- **Não** aplica desconto automático por fiscalização — ver
  [ADR 0004](../decisoes/0004-proctoring-nao-acusa-automaticamente.md).
- **Não** acusa o aluno de nada. A avaliação interna relata sinais; a conclusão é
  humana.
- **Não** exige que o aluno repita as palavras do gabarito: o critério premia
  entendimento demonstrado, incluindo paráfrase e sinônimo.
- **Não** deixa a fiscalização contaminar a leitura de conteúdo.

## Cenários

- **Dado** um trabalho com rubrica de dois critérios com pesos 3 e 1, **quando** o
  aluno tira 8 e 4, **então** a nota final é 7,0, calculada em código.
- **Dado** que o professor discorda da nota sugerida, **quando** ele a edita e
  publica, **então** o aluno vê a nota do professor.
- **Dado** que a devolutiva já foi publicada e a nota não, **quando** o aluno abre
  o link, **então** vê apenas a devolutiva.
- **Dado** um aluno com alerta de "mais de uma pessoa" no vídeo, **quando** a nota
  é calculada, **então** ela não sofre desconto — o alerta aparece para o
  professor decidir.

## Referência técnica

`lib/rubric.js` (média ponderada), `agents/` (avaliadores). Mapa de prompts em
[`docs/architecture.md`](../architecture.md).

## Decisões relacionadas

- [ADR 0004 — Fiscalização não acusa automaticamente](../decisoes/0004-proctoring-nao-acusa-automaticamente.md)
- [ADR 0009 — Nota e devolutiva têm publicações independentes](../decisoes/0009-nota-e-devolutiva-publicam-separado.md)

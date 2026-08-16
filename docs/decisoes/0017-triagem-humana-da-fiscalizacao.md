# 0017 — A triagem da fiscalização é humana e alimenta o pipeline

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

A [ADR 0004](0004-proctoring-nao-acusa-automaticamente.md) removeu a penalidade
automática: fiscalização virou sinal para revisão humana. Só que a revisão humana
não tinha onde morar. O professor via o alerta, entrava na avaliação, assistia
aos trechos, formava um juízo — e o juízo se perdia. Não dava para retomar
depois, nem para a avaliação e a devolutiva levarem em conta o que ele concluiu.

Também não dava para saber **o que ainda falta revisar**, que é a fila de
trabalho dele.

## Decisão

Cada submissão carrega um veredito do professor sobre os indícios, com seis
níveis (`não revisado` · `sem problema` · `em aberto` · `confirmado leve /
moderado / grave`) e um campo livre de observação.

`não revisado` é **distinto** de `em aberto`: um significa que ninguém olhou, o
outro que olhou e ficou inconclusivo. Sem essa distinção não existe fila.

O veredito alimenta o pipeline, com três guardas herdadas da ADR 0004:

- **A nota não muda sozinha.** O rótulo é contexto; quem ajusta é o professor.
- **`sem problema` SUPRIME o alerta automático na devolutiva.** Se um humano
  reviu o vídeo inteiro e descartou, insistir com o aluno seria acusar o que já
  foi inocentado.
- **`não revisado` e `em aberto` não entram na devolutiva.** Inconclusivo não é
  achado; comunicar dúvida como constatação é acusação implícita.

Só `confirmado_*` chega ao aluno, e ainda assim em linguagem formativa, sem
imputar causa.

## Consequências

- O gerador da devolutiva passa a receber duas coisas distintas — os sinais
  automáticos e o juízo humano — e a segunda pode anular a primeira.
- A enumeração vai em **tabela + FK pela chave estável**, não em `CHECK`
  ([ADR 0011](0011-enumeracoes-em-tabela.md)): estes níveis vão evoluir, e a
  própria issue já os propôs "aceitando revisão".
- Surge um dado novo que ninguém preenche por padrão. Enquanto a adoção não
  acontecer, tudo fica em `não revisado` e o comportamento é o de antes —
  degradação silenciosa e correta.
- **Efeito colateral desejado:** o campo de observação é o começo do conjunto
  rotulado que hoje não existe para medir melhorias no detector (#250).

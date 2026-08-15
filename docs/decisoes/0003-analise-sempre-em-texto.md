# 0003 — Análise sempre em texto; áudio é última milha

> **Estado:** Aceita
> **Data:** 2026-06 (registrada em 2026-08-15)

## Contexto

Com entrada e saída em voz, é tentador passar áudio direto aos agentes. Isso
acopla a qualidade da avaliação à qualidade do áudio, multiplica custo por
modalidade e torna impossível reprocessar uma avaliação antiga.

## Decisão

Áudio existe **apenas** na interface com o aluno: transcrição na entrada,
síntese na saída. Agentes, avaliadores, mapa do documento, base vetorial, log da
conversa e relatório final operam somente sobre texto. Nunca passar áudio a um
agente.

## Consequências

- A avaliação é reprodutível e reprocessável a partir da transcrição.
- Perde-se sinal prosódico — hesitação, entonação — que poderia informar sobre
  segurança do aluno. Aceito.
- Erro de transcrição vira erro de avaliação. Daí existir calibração de fala e
  um pré-portão de inteligibilidade.
- O áudio sintetizado do arguidor **não** é persistido (cache em memória), por
  anti-vazamento; o áudio do aluno **é** arquivado, por LGPD.

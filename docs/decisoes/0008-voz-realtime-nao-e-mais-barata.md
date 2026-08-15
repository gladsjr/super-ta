# 0008 — Voz em tempo real não é mais barata que mensagens

> **Estado:** Aceita
> **Data:** 2026-07-28 (registrada em 2026-08-15)

## Contexto

A entrevista em tempo real foi construída sob a hipótese de ser bem mais barata
que a entrevista por mensagens, porque não faz raciocínio por turno. As primeiras
medições confirmavam — mas estavam erradas: o modelo de voz **não tinha preço
configurado** e vinha sendo contabilizado como US$ 0 desde 07/07.

## Decisão

Registrar que a hipótese foi **refutada**: com o preço correto, a arguição em voz
em tempo real não é mais barata que a por mensagens. Decisões de produto não
podem se apoiar nessa premissa.

## Consequências

- O histórico de custo daquele período está contaminado e precisaria de backfill
  para ser comparável.
- Reforça a [ADR 0002](0002-falhar-explicito-sem-fallback.md): preço ausente
  passou a derrubar o boot.
- Lição transferível: número que confirma a hipótese confortável merece uma
  checagem a mais.

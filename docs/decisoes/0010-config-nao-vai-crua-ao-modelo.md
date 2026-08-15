# 0010 — Configuração nunca vai crua ao modelo

> **Estado:** Aceita
> **Data:** 2026-06 (registrada em 2026-08-15)

## Contexto

Os arquivos de configuração do arguidor descrevem persona, objetivos, critérios e
modo de avaliação em campos estruturados. Jogar o arquivo cru no prompt faz o
modelo adivinhar o que cada campo significa — e adivinhar diferente a cada
versão do modelo.

## Decisão

Configuração estruturada passa **sempre** por um template que explica o
significado de cada campo antes de chegar ao modelo. Quem precisa da agenda do
arguidor usa a função compartilhada que faz isso; não se recria a estrutura.

## Consequências

- Campo novo na configuração exige atualizar o template junto — senão ele entra
  mudo.
- O prompt fica maior, o que pressiona custo de entrada. Mitigado pelo cache de
  prefixo, já que o bloco é estável.
- Exceção deliberada: a linguagem de pacotes é configuração pura e **nunca** vai
  ao modelo, então não segue esta regra.

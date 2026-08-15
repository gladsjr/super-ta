# 0004 — Fiscalização não acusa nem penaliza automaticamente

> **Estado:** Aceita
> **Data:** 2026-08-13

## Contexto

Existia um agente que lia os alertas de fiscalização e a política do professor e
devolvia um multiplicador de 0 a 1 aplicado sobre a nota da rubrica. Na prática,
isso transformava um sinal ruidoso — detecção de celular confunde mão perto do
rosto; "segunda pessoa" confunde o próprio braço do aluno na borda do quadro — em
consequência automática sobre a vida acadêmica de alguém.

## Decisão

A penalidade automática foi **removida**. Fiscalização é sinal para revisão
humana, nunca acusação. Os alertas são exibidos ao professor, que ajusta a nota
manualmente se julgar necessário, e podem colorir a devolutiva do aluno em tom
não acusatório. A nota é a média ponderada da rubrica, e nada mais.

## Consequências

- O professor tem trabalho manual quando há alerta. É o ponto: a decisão é dele.
- A fiscalização deliberadamente **não** entra no raciocínio da avaliação de
  conteúdo — integridade e conteúdo ficam separados.
- Defensável perante instituição e aluno: não há decisão automatizada com efeito
  adverso, o que também simplifica a conversa de LGPD.
- Supersede o comportamento anterior; a coluna que guardava o multiplicador
  permanece por compatibilidade histórica.

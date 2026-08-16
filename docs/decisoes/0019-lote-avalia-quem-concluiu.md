# 0019 — O lote avalia quem concluiu; o resto é decisão individual

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

O filtro do lote excluía apenas submissões sem envio. Entravam, portanto: envios
de **teste** do próprio professor, arguições **em andamento** e **desistências**.

Em produção, seis desistências já tinham sido avaliadas em lote, e onze envios de
teste concluídos entravam como qualquer aluno — gastando LLM e poluindo a turma
com linhas que não são de ninguém.

## Decisão

Um predicado único de elegibilidade de lote — não é de teste **e** concluiu —
compartilhado pelos lotes que custam LLM, com a mesma regra escrita em JS (para a
entrevista, que filtra em memória) e em SQL (para a prova oral, que filtra na
consulta).

O `force` **não fura** a regra: refazer o que já foi feito é uma coisa; arrastar
para dentro do lote quem não deveria entrar é outra.

Avaliar individualmente segue liberado para todos — é uma decisão explícita do
professor, e há motivos legítimos (uma desistência por problema técnico que ele
queira avaliar assim mesmo).

## Consequências

- O lote passa a **contar e mostrar quem ficou de fora, e por quê**. Sem isso o
  professor não distingue "o sistema esqueceu" de "não entra por regra".
- Arguição em andamento deixa de ser avaliada pela metade — o que, além de
  produzir relatório sobre prova inacabada, fazia o lote seguinte pular o aluno
  por ele já ter versão gerada.
- A regra vive em dois idiomas (JS e SQL) e precisa ser mudada nos dois. Por isso
  moram no mesmo arquivo, com teste que compara as duas leituras.

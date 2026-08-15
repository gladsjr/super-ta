# 0006 — Um raciocínio por turno, guardas no código

> **Estado:** Aceita
> **Data:** 2026-06 (registrada em 2026-08-15)

## Contexto

A condução da entrevista já foi uma frota de agentes: triagem em três vias,
checagem de suficiência, checagem de relevância. Muitas chamadas, difícil de
depurar, e o comportamento emergia da interação entre elas — ninguém conseguia
dizer por que a entrevista tinha feito o que fez.

## Decisão

Concentrar a carga cognitiva do turno em **uma única chamada** de modelo de
raciocínio, que recebe o contexto completo e devolve uma ação estruturada. O
código é um despachante em volta dessa decisão, com **guardas duras**: teto de
turnos, bloqueio de encerramento antecipado, saída inválida vira "pedir para
repetir". O mesmo princípio vale para o subsistema de cenários.

## Consequências

- Uma chamada cara por turno em vez de várias baratas. O custo é dominado pelo
  raciocínio, e por isso o esforço de raciocínio virou alavanca de custo.
- A decisão do turno fica auditável: há uma justificativa registrada por ação.
- As guardas ficam **no código, não no prompt** — a única forma de garanti-las.

# 0014 — O endpoint de análise consulta tabelas-base, não views

> **Estado:** Aceita
> **Data:** 2026-07-28

## Contexto

A primeira versão do acesso analítico à produção usava um schema separado
contendo apenas *views*: elas esconderiam dados pessoais e conteriam o alcance
das consultas, funcionando como defesa contra nós mesmos.

**Quebrou em produção.** O fluxo de Publish do Replit só reconcilia objetos "de
tabela" no schema padrão — tabelas, colunas, índices e constraints por nome. Ele
**não propaga schemas alternativos, nem views, nem funções**. As views existiam
em desenvolvimento e simplesmente não chegavam à produção, então o endpoint
apontava para o vazio. É a mesma família de armadilha da
[ADR 0001](0001-migrations-nao-rodam-no-boot.md).

## Decisão

O endpoint consulta as **tabelas-base** diretamente, com os campos derivados
calculados na própria consulta. A segurança fica onde o Publish não alcança e
onde ela é mais forte de qualquer modo: transação somente-leitura no Postgres,
tempo-limite curto, `LIMIT` forçado e uma guarda de código contra não-`SELECT` e
contra objetos de sistema.

## Consequências

- A proteção que as views dariam era, na prática, redundante: quem tem o token já
  tem direito aos dados, e o token expira, é revogável e é auditado.
- Em troca, **não há mais uma camada que esconda dado pessoal por construção**. O
  cuidado passa a ser de processo — quem recebe o token, por quanto tempo, e para
  quê.
- Regra que fica: **não construa nada que dependa de objeto não propagado pelo
  Publish** (schema alternativo, view, função). Se a solução exige um desses,
  ela vai funcionar em desenvolvimento e falhar em produção.
- Consultas ficam mais verbosas, porque a derivação que estaria na view é
  repetida em cada consulta nomeada.

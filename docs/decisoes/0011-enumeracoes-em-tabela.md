# 0011 — Enumerações que evoluem vão em tabela, não em CHECK

> **Estado:** Aceita
> **Data:** 2026-08-04

## Contexto

Enumerações declaradas como `CHECK` de strings parecem baratas, mas evoluí-las
esbarra numa armadilha conhecida do Publish do Replit: **mudar a definição de uma
constraint mantendo o mesmo nome não propaga para produção**. A alternativa
ingênua — id numérico cru espalhado pelo código — mata a legibilidade.

## Decisão

Enumeração que pode crescer vira **tabela com chave estrangeira**: id numérico
interno, uma chave textual estável que o código referencia, e um nome de
exibição traduzível. As linhas são sincronizadas por seed a partir de uma
constante no código. Exemplo: papéis.

## Consequências

- Evoluir a enumeração passa a ser manipulação de dados, que o Publish propaga.
- Exige um seed rodando depois das migrations — seeds e migrations continuam
  separados.
- `CHECK` segue válido para invariante estrutural estável, que não é enumeração.
- Nomear a constraint com nome novo é o contorno quando é preciso mesmo mudar
  uma definição existente.

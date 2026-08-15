# Camada institucional

> **Estado: parcial** · revisado em 2026-08-15
> Migrations 055–066. Aditiva e opcional — **não** quebra o modelo por link
> individual, que continua funcionando sem nada disso.

**Uma frase:** unidades em árvore (instituição → escola → curso → turma), papéis
atribuídos por unidade, login que aceita mais de uma instituição, e os portões de
uso pendurados nessa árvore.

## Para quem serve

Venda institucional. Sem essa camada, o produto funciona por link avulso: bom
para um professor sozinho, insuficiente para uma faculdade que precisa de
hierarquia, controle de acesso e orçamento por curso.

## O que existe

- **Unidades em árvore recursiva**, com uma marcação de "isto é uma turma".
- **Papéis por unidade**: administrador, professor, aluno. A herança pela árvore
  vale **só para administrador** — professor e aluno são locais ao nó. A razão é
  que disponibilidade não é a mesma coisa que acesso.
- **Identidade separada de login**: uma pessoa (identificada civilmente) pode ter
  várias identidades de autenticação — senha local, Google — e cada unidade
  declara quais provedores aceita.
- **Portões de uso** por unidade: teto em dólares e pacotes de avaliação, ambos
  como reserva com devolução. Ver [controle de uso](controle-de-uso-e-custo.md).

## O que esta capacidade NÃO faz

- **Não** substitui o modelo por link individual — os dois coexistem.
- **Não** dá acesso por herança a professor: estar acima na árvore não é estar
  dentro da turma.
- **Não** está completa. A autenticação multi-instituição foi projetada em fases
  e nem toda fase chegou à produção; parte do trabalho ainda vive em branch.

## Cenários

- **Dado** um administrador na unidade "FGV", **quando** ele abre uma turma três
  níveis abaixo, **então** tem acesso por herança.
- **Dado** um professor com papel na turma A, **quando** ele tenta abrir a turma B
  da mesma escola, **então** não tem acesso.
- **Dado** uma unidade que aceita apenas login federado, **quando** um usuário
  tenta entrar com senha local, **então** o acesso é recusado pelo provedor
  aceito daquela unidade.

## Referência técnica

[`docs/access-model.md`](../access-model.md) — modelo completo.
`routes/units.js`, `routes/authFederated.js`, `lib/units.js`, `lib/rbac.js`,
`lib/packages.js`.

## Decisões relacionadas

- [ADR 0011 — Enumerações que evoluem vão em tabela, não em CHECK](../decisoes/0011-enumeracoes-em-tabela.md)

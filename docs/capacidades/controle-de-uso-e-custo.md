# Controle de uso e custo

> **Estado:** em produção · revisado em 2026-08-15

**Uma frase:** cada trabalho tem um teto de gasto, cada chamada ao modelo é
medida e contabilizada, e — na camada institucional — o uso é limitado por cotas
que funcionam como **reserva com devolução**.

## Por que isso é capacidade de produto, e não detalhe técnico

Porque o preço de venda é derivado do custo medido. O custo de IA por avaliação
está na casa dos centavos de dólar, mas varia muito entre alunos (na prova oral,
a dispersão individual chega a seis vezes), e é a média da turma que sustenta a
margem. Sem medição confiável não há precificação defensável.

## O que existe

- **Teto por trabalho** em dólares. Operações que gastam verificam o teto antes
  de rodar.
- **Medidor por chamada**: entrada, entrada em cache, escrita de cache e saída,
  cada uma cobrada pelo seu preço, com o preço vindo de um arquivo de
  configuração — nunca embutido no código.
- **Registro por agente**, o que permite responder "quanto custou cada etapa" sem
  instrumentação nova.
- **Cotas por unidade** (camada institucional): tanto um teto em dólares quanto
  pacotes de avaliações. Ambos funcionam como **reserva** — o valor é descontado
  do saldo do pai no ato, e devolvido se não for usado.
- **Endpoint de análise somente-leitura** sobre as tabelas de produção, com token
  gerado no admin e validade fixa, para consultar custo e uso reais.

## O que esta capacidade NÃO faz

- **Não** corta uma sessão em andamento no meio por estouro de teto — o teto é
  verificado antes de operações caras.
- **Não** aceita preço embutido no código: a tabela de preços é configuração.
- **Não** deixa unidade-raiz sem limite quando há pacotes em uso.

## Armadilhas conhecidas

- **Modelo sem preço configurado sai como zero.** Já aconteceu: a voz em tempo
  real foi contabilizada como US$ 0 por um mês inteiro porque o modelo não estava
  na tabela. Hoje o boot falha se faltar preço, mas o histórico daquele período
  segue contaminado.
- **Eventos de pós-arguição sem identificação do aluno** subcontam o custo por
  aluno (o total do trabalho fica certo). Qualquer número "por submissão" precisa
  checar isso antes de ser publicado.

## Cenários

- **Dado** um trabalho com teto de US$ 20 já consumido, **quando** o professor
  manda avaliar em lote, **então** a operação é recusada por orçamento.
- **Dado** um modelo novo sem preço na configuração, **quando** o servidor sobe,
  **então** ele falha no boot em vez de contabilizar zero.
- **Dado** uma unidade-filha com pacote alocado e não usado, **quando** o pacote é
  devolvido, **então** o saldo volta para a unidade-pai.

## Referência técnica

`lib/billing.js`, `config/pricing.yaml`, `config/packages/*.yaml`,
`routes/analytics.js`. Detalhe da camada institucional em
[`docs/access-model.md`](../access-model.md).

## Decisões relacionadas

- [ADR 0002 — Falhar explícito, sem fallback arquitetural](../decisoes/0002-falhar-explicito-sem-fallback.md)

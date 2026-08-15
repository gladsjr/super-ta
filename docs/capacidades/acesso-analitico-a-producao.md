# Acesso analítico à produção

> **Estado:** em produção · revisado em 2026-08-15
> Usuário desta capacidade: **a equipe e os agentes que a auxiliam**.

**Uma frase:** um endpoint somente-leitura que permite consultar os dados reais
de produção — custo, uso, conversas, notas — sem passar pelo console do Replit e
sem risco de escrever qualquer coisa.

## Para que serve

O gargalo era medir sobre o banco local, onde não há aluno real. Decisões de
custo, de precificação e de qualidade dependem de produção; abrir o console a
cada pergunta é lento e perigoso. Este endpoint troca isso por uma consulta
direta, com o Postgres — e não o código — garantindo que nada seja escrito.

## Como funciona

- **Consultas nomeadas** prontas para as perguntas recorrentes (custo por tipo,
  por modelo, por submissão, estatísticas de turno, distribuição de notas,
  motivos de encerramento, trabalhos recentes, submissões caras, amostra de
  conversa) e **SQL livre** para o resto.
- **Autenticação por token gerado no painel de administração**, com validade
  fixa. O banco guarda apenas o hash; o valor em claro aparece uma única vez, na
  geração, e pode ser revogado. Toda consulta é auditada.
- **Barreiras em camadas**, com a garantia dura no banco e não no código:

| Camada | O que impede |
|---|---|
| Transação `READ ONLY` | Qualquer escrita — o próprio Postgres recusa. |
| `statement_timeout` curto | Consulta pesada derrubar produção. |
| `LIMIT` forçado | Retorno gigante. |
| Guarda de código | Não-`SELECT`, e acesso a objetos de sistema. |

A ordem importa: a guarda de código é a primeira barreira e existe para dar erro
claro, mas quem garante é a transação somente-leitura.

## A pegadinha que moldou o desenho

A primeira versão usava um schema separado só de *views*, para esconder dados
pessoais e conter o alcance. **Quebrou em produção**: o Publish do Replit só
reconcilia objetos "de tabela" no schema padrão — não propaga schemas
alternativos, views nem funções. A solução foi consultar as **tabelas-base**
direto. Ver [ADR 0013](../decisoes/0013-analytics-consulta-tabelas-base.md).

A proteção que as views dariam era, na prática, redundante: quem tem o token já
tem direito aos dados, e o token expira, é revogável e é auditado.

## O que esta capacidade NÃO faz

- **Não** escreve nada, em nenhuma circunstância.
- **Não** dispensa cuidado com dado pessoal: o acesso é a produção real, com
  conversas de alunos identificáveis. Token é credencial pessoal, não
  compartilhável.
- **Não** substitui o medidor de custo do produto — ela **lê** o que o medidor
  gravou. Se o medidor errou, a consulta reproduz o erro fielmente.
- **Não** enxerga o que não foi gravado: eventos de pós-arguição sem
  identificação de aluno subcontam o custo por aluno. Qualquer número "por
  submissão" precisa checar isso antes de virar decisão.

## Cenários

- **Dado** um token válido, **quando** se envia um `SELECT`, **então** o
  resultado volta limitado e a consulta fica registrada.
- **Dado** um `UPDATE` disfarçado, **quando** ele chega ao endpoint, **então** é
  recusado — e, mesmo se passasse pela guarda, a transação somente-leitura o
  barraria.
- **Dado** um token expirado ou revogado, **quando** ele é usado, **então** o
  acesso é negado sem revelar se a consulta seria válida.
- **Dado** que se quer medir custo real por forma de arguição, **quando** se roda
  a consulta nomeada correspondente, **então** os números saem das tabelas de
  produção sem passar pelo Replit.

## Referência técnica

`routes/analytics.js` (consultas nomeadas, guardas, execução somente-leitura),
`lib/db/analyticsTokens.js` (emissão, hash, revogação), seção "Análise" em
`static/admin.html`.

## Decisões relacionadas

- [ADR 0013 — O endpoint de análise consulta tabelas-base, não views](../decisoes/0013-analytics-consulta-tabelas-base.md)
- [ADR 0001 — Migrations não rodam no boot](../decisoes/0001-migrations-nao-rodam-no-boot.md) — mesma família de armadilha do Publish

# Configuração do trabalho

> **Estado:** em produção · revisado em 2026-08-15

**Uma frase:** o professor descreve o que quer avaliar — material, estilo do
arguidor, número de perguntas, rubrica — e o sistema prepara a arguição e gera os
acessos individuais dos alunos.

## Para quem serve

É a porta de entrada do produto para o professor, e o ponto onde quase todo o
comportamento posterior é decidido. Uma consequência prática: **a maior parte das
reclamações sobre "a entrevista fez X" se resolve aqui**, não no motor.

## O que o professor configura

| Decisão | Efeito |
|---|---|
| **Forma de arguição** | Prova oral, entrevista simplificada ou profunda. Ver o [mapa](README.md). |
| **Material** | Enunciado do trabalho (entrevistas) ou material da prova (oral). |
| **Persona do arguidor** | O caráter que conduz. Domina custo **e** nota — é a alavanca mais subestimada. |
| **Número de perguntas** | 3 a 20, padrão 6. Governa também os limites de turno. |
| **Modo e voz** | Texto ou voz; a voz vem de um catálogo. |
| **Fiscalização por vídeo** | Liga a câmera obrigatória. |
| **Rubrica** | Critérios e pesos da nota. |
| **Teto de orçamento** | Limite de gasto do trabalho. Ver [controle de uso](controle-de-uso-e-custo.md). |

Há ainda um **assistente de configuração** com quem o professor conversa em
linguagem natural, e uma **checagem de coerência do enunciado** antes de aplicar.

## O que sai

- O trabalho publicado, com **um link individual por aluno** (gerado avulso ou em
  lote).
- No caso das entrevistas, a preparação por aluno acontece quando ele envia o
  PDF: o sistema analisa o documento e monta o plano de perguntas daquele aluno.
- Na prova oral, a preparação é uma só e amortiza pela turma — por isso ela é a
  forma mais barata.

## O que esta capacidade NÃO faz

- **Não** aceita configuração parcial silenciosa: falta de configuração
  obrigatória falha explicitamente, em vez de adivinhar um padrão — ver
  [ADR 0002](../decisoes/0002-falhar-explicito-sem-fallback.md).
- **Não** deixa o professor trocar a forma de arguição de uma sessão em
  andamento. Mudanças valem para quem ainda não começou ou vai reenviar o PDF.
- **Não** manda os arquivos de configuração crus ao modelo: eles passam por um
  template que explica cada campo.

## Cenários

- **Dado** um trabalho em andamento, **quando** o professor muda o modo de
  interação, **então** a mudança vale para novos alunos e para quem reenviar o
  PDF — nunca no meio de uma sessão já iniciada.
- **Dado** um enunciado incoerente com a persona escolhida, **quando** o professor
  roda a checagem, **então** recebe o apontamento antes de publicar.
- **Dado** que falta uma configuração obrigatória de modelo, **quando** o sistema
  sobe, **então** ele falha no boot em vez de escolher um padrão.

## Referência técnica

`routes/admin.js` e `routes/work.js` (endpoints do professor), `static/professor.html`
e `static/admin.html`, `config/interviewers/*.yaml` (catálogo de personas).

## Decisões relacionadas

- [ADR 0002 — Falhar explícito, sem fallback arquitetural](../decisoes/0002-falhar-explicito-sem-fallback.md)
- [ADR 0010 — Configuração nunca vai crua ao modelo](../decisoes/0010-config-nao-vai-crua-ao-modelo.md)

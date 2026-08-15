# Devolutiva ao aluno

> **Estado: EM REVISÃO** · revisado em 2026-08-15
> ⚠️ Há uma decisão de produto de **retirar a devolutiva da oferta**, tomada em
> 2026-08-12 e ainda **não** refletida no código nem nos trabalhos em produção.
> Esta página descreve o comportamento **atual**; a seção final registra a
> pendência. Não trate o que está aqui como estável.

**Uma frase:** um texto formativo derivado da avaliação interna, higienizado de
bastidores e de suspeitas, que o professor revisa e publica quando quiser.

## O que ela é hoje

- Gerada a partir da **avaliação interna**, nunca do zero.
- Passa por **duas camadas de higienização**: regras no próprio prompt e uma
  varredura por padrões proibidos, para não vazar ao aluno a linguagem
  investigativa da avaliação interna.
- Tem **seções que o professor liga e desliga** por trabalho: pontos fortes,
  áreas de melhoria, sugestões de estudo e opinião do entrevistador.
- Pode, opcionalmente, incorporar uma nota **suave e não acusatória** sobre a
  fiscalização por vídeo.
- Existe nas três formas de arguição; na prova oral, reaproveita o mesmo gerador.
- A publicação difere por forma: na **entrevista** ela é independente da nota
  ([ADR 0009](../decisoes/0009-nota-e-devolutiva-publicam-separado.md)); na
  **prova oral**, as duas publicam juntas
  ([ADR 0012](../decisoes/0012-publicacao-conjunta-na-prova-oral.md)).

## O que esta capacidade NÃO faz

- **Não** vai ao aluno automaticamente: exige publicação explícita.
- **Não** repassa a avaliação interna. São documentos diferentes, com públicos
  diferentes.
- **Não** acusa, nem insinua fraude.

## Cenários

- **Dado** que a avaliação interna registrou suspeita de autoria, **quando** a
  devolutiva é gerada, **então** o texto não menciona a suspeita.
- **Dado** que o professor desligou "sugestões de estudo", **quando** a devolutiva
  é publicada, **então** essa seção não aparece para o aluno.

## Pendência de produto (2026-08-12)

A decisão registrada foi: **retirar a devolutiva**, mantendo **nota por rubrica**
na prova oral e **parecer da persona** nas entrevistas. Duas perguntas ficaram em
aberto e definem o tamanho da mudança:

1. Sai **só da prova oral** ou das três formas?
2. Sai do **produto** (remover geração, rotas, telas e colunas) ou apenas da
   **oferta comercial** (continua no código, desligada por padrão e fora do
   pacote)?

Enquanto isso não se resolve, o comportamento em produção é o descrito acima —
inclusive em trabalhos ativos, que continuam com as quatro seções ligadas.
**Quando a decisão for implementada, esta página deve ser reescrita ou removida,
e uma ADR registrada.**

## Referência técnica

`lib/oralFeedbackOps.js` (prova oral), `agents/` (gerador compartilhado),
`routes/work.js` e `routes/oralExam.js` (rotas de gerar, salvar e publicar).

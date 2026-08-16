# 0016 — Na entrevista em tempo real, turno é pergunta do plano

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

Na entrevista simplificada não há orquestrador emitindo intervenções: o
transcript da sessão de voz é convertido em turnos no encerramento. A regra era
**toda fala do entrevistador depois de uma fala do aluno abre um turno novo**.

Numa conversa falada o entrevistador naturalmente confirma ("entendi"),
reformula, faz ponte e pede complemento — e cada uma dessas viraria um turno. O
efeito medido em produção:

| Variante | Perguntas configuradas | Turnos (média) |
|---|---|---|
| por mensagens | 4,8 | 4,9 (1:1) |
| em tempo real | 5,0 | **10,3 (~2×)** |

Um aluno chegou a **14 turnos para 5 perguntas**. Como a avaliação interna
produz uma entrada por turno, o avaliador comentava confirmação e ponte de
transição como se fossem questões avaliáveis.

## Decisão

**Turno = pergunta do plano.** Só a fala do entrevistador que casa com uma
pergunta do plano abre turno; as demais viram **intervenções do turno corrente** —
a mesma estrutura que a entrevista por mensagens sempre usou para esse
comportamento. Nenhuma fala é descartada.

Rede de segurança: se o casamento não encontrar **nenhuma** pergunta do plano
(plano muito parafraseado, transcrição ruim), cai para a segmentação antiga por
fala. Infla a contagem, mas nunca colapsa a conversa num turno só.

## Consequências

- O casamento com o plano deixa de ser informativo e passa a **definir a
  estrutura** — um casamento errado agora tem custo maior. O limiar segue
  conservador (70% dos termos de conteúdo da pergunta) e o casamento é guloso na
  ordem da conversa, que é a ordem em que o plano é percorrido.
- A comparação entre as duas variantes passa a fazer sentido: antes, "turnos" era
  uma métrica que significava coisas diferentes em cada via.
- **Não muda custo.** O avaliador da variante em tempo real custa menos por
  chamada que o da via por mensagens (turnos de voz são curtos), e a segmentação
  é posterior à sessão. Isto é qualidade de avaliação, não gasto.
- Conversas antigas, já gravadas, seguem com a segmentação velha. A mudança vale
  para sessões novas; reprocessar as antigas exigiria regravar o
  `conversation_json` a partir do transcript.

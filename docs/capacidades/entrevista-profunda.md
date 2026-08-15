# Entrevista profunda

> **Estado:** em produção · revisado em 2026-08-15
> `works.kind = 'interview'` · `works.interview_variant = 'messages'`

**Uma frase:** o aluno é arguido sobre o trabalho que ele mesmo entregou, e o
arguidor decide a cada turno se avança, insiste ou muda de rumo — é a forma que
mais extrai evidência, e a mais cara.

## Para quem serve

Quando o trabalho escrito mede mal o que o aluno de fato entendeu: monografia,
projeto, relatório técnico, estudo de caso. É a forma que expõe autoria e
domínio, porque cada pergunta nasce do texto daquele aluno e o arguidor cobra
quando a resposta escorrega.

## O que o professor configura

- **Enunciado do trabalho** (PDF) e o **estilo do entrevistador** (a persona).
- **Número de perguntas** (3 a 20, padrão 6). Ele governa os limites da conversa:
  o encerramento é forçado em `perguntas × 3` turnos, e o encerramento antecipado
  é bloqueado antes da metade.
- **Modo de interação** (texto ou voz) e a voz, quando for voz.
- **Fiscalização por vídeo** e a **rubrica** de nota.
- Opcionalmente, a expectativa de **resposta de cabeça** (sem material de apoio) —
  desligada automaticamente quando há fiscalização por vídeo, porque a câmera já
  cumpre esse papel.

## O que o aluno vive

1. Abre o link individual e **envia o próprio trabalho** em PDF. Enquanto o
   sistema analisa o documento e monta o plano de perguntas, ele passa pelo setup.
2. Passa por uma **introdução** conduzida pelo entrevistador.
3. Responde às perguntas. Cada resposta é lida por um raciocínio que decide o
   próximo passo: perguntar o item seguinte do plano, **aprofundar** o que ficou
   vago, dar uma dica, pedir para repetir, ou encerrar.
4. Ao fim, pode deixar um comentário ao professor.

Se o servidor reiniciar no meio, a sessão é retomada de onde parou.

## O que sai no fim

- **Conversa completa** — perguntas, respostas, aprofundamentos e o motivo de
  cada intervenção.
- **Avaliação interna** para o professor (nunca mostrada ao aluno).
- **Nota por rubrica**, quando configurada.
- **Sinais de fiscalização**, quando ligada.
- **Devolutiva** — hoje existe, mas está [em revisão](devolutiva.md).

## O que esta capacidade NÃO faz

- **Não** ensina nem corrige durante a sessão. É arguição, não tutoria: o sistema
  investiga quem está por trás do texto.
- **Não** dita a resposta nem induz o aluno à conclusão — há guarda explícita
  contra isso, adicionada depois que um professor flagrou o entrevistador
  entregando a resposta na própria pergunta.
- **Não** exige cálculo ao vivo: as perguntas são formuladas para serem
  respondidas de cabeça, sem consultar planilha.
- **Não** manda áudio para os agentes. Voz é só a última milha — ver
  [ADR 0003](../decisoes/0003-analise-sempre-em-texto.md).
- **Não** deixa o vídeo da fiscalização chegar à OpenAI.

## Cenários

- **Dado** um trabalho configurado com 6 perguntas, **quando** o aluno enrola e a
  conversa chega a 18 turnos, **então** a entrevista é encerrada à força.
- **Dado** que o aluno respondeu de forma genérica, **quando** o arguidor avalia a
  resposta, **então** ele aprofunda o mesmo ponto em vez de seguir para a próxima
  pergunta — e o motivo do aprofundamento fica registrado.
- **Dado** que a resposta contradiz um número do próprio trabalho, **quando** o
  aluno tenta contornar com uma ressalva metodológica, **então** o arguidor
  reafirma o ponto objetivo e volta a pedir a reconciliação.
- **Dado** que o servidor reiniciou no meio da entrevista, **quando** o aluno
  recarrega a página, **então** ele retoma do ponto em que parou.
- **Dado** que a fiscalização por vídeo está ligada, **quando** o professor abre a
  configuração, **então** a opção de "resposta de cabeça" aparece desabilitada.

## Referência técnica

[`docs/architecture.md`](../architecture.md) — ciclo `/chat` e mapa de prompts.
[`docs/super-orchestrator-plan.md`](../super-orchestrator-plan.md) — racional e schema da ação.

## Decisões relacionadas

- [ADR 0003 — Análise sempre em texto](../decisoes/0003-analise-sempre-em-texto.md)
- [ADR 0006 — Um raciocínio por turno, guardas no código](../decisoes/0006-um-raciocinio-por-turno.md)
- [ADR 0005 — Vídeo obrigatório e bloqueante](../decisoes/0005-video-obrigatorio-e-bloqueante.md)

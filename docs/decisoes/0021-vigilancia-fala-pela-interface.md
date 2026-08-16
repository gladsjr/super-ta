# 0021 — Vigilância ao vivo fala pela interface, e a gravação vale mais que a detecção

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

O setup dos fluxos de voz exige posição correta (cabeça, tronco, distância,
mãos), mas é um portão em t=0: o aluno satisfaz o detector uma vez e relaxa. Em
produção, as mãos ficam fora do quadro em 8–14% do tempo, e um aluno mal
enquadrado por 40 minutos produz um vídeo que ninguém consegue revisar depois —
problema de QUALIDADE da gravação antes de ser de integridade.

Cobrar posição no meio da prova esbarrava em dois riscos. Primeiro, a voz: a
sessão Realtime tem detecção de fala — um aviso falado viraria fala do aluno ou
resposta do modelo, e o arguidor cobrando posição seria a autoridade acusando
([ADR 0004](0004-proctoring-nao-acusa-automaticamente.md)). Segundo, a CPU:
visão computacional contínua competiria com o caminho de voz em tempo real e com
o `MediaRecorder` — e todas as 5 quedas de gravação históricas foram justamente
nos fluxos de voz, onde a máquina já está carregada.

## Decisão

A vigilância de posição ao vivo (issue #267) obedece três regras:

1. **Fala pela INTERFACE, nunca pela voz do arguidor.** Posição inadequada
   sustentada (10 s) pausa a arguição — o silêncio é o aviso — e abre um modal
   autoresolvido (câmera ao vivo ao lado das fotos canônicas de posição, zero
   cliques) que some quando o aluno sustenta a posição correta (~3 s).
2. **A gravação é o ativo; a detecção é conveniência.** O regime é mínimo — um
   quadro a cada 2,5 s, só pose, no MESMO tick de presença que já existia
   (nenhuma inferência extra). A própria máquina se mede: mediana de inferência
   acima do orçamento (~80 ms) desliga a vigilância; queda de captura também.
   Sob qualquer conflito, a detecção morre primeiro, a gravação nunca.
3. **Desligada vira SINAL, não silêncio** ([ADR 0018](0018-limiar-destaca-nao-oculta.md)):
   o estado (`ativo` / `desligado_por_desempenho` / `desligado_apos_queda` /
   `indisponivel`) e as pausas vão ao professor via `oral_voice_json.live_nudges`.

Ao vivo só se cobra o que o aluno pode consertar: enquadramento, distância,
mãos à mostra (punhos da pose). Celular e segunda pessoa ficam na análise
posterior — avisar "detectei um celular" ao vivo seria acusação automática, com
um detector que comprovadamente erra (#250).

## Consequências

- O aluno pode ser pausado no meio de um raciocínio por estar mal sentado. O
  limiar de 10 s sustentados existe para reduzir isso, mas o incômodo é real.
- Punho visível na pose é aproximação: mão fechada atrás do notebook pode passar,
  mão aberta no colo pode reprovar. O veredito fino continua na análise
  pós-prova; ao vivo é só aviso.
- Máquinas lentas não recebem a vigilância — a equidade entre alunos não é
  perfeita, e é deliberado: a alternativa (arriscar a gravação de quem tem
  máquina fraca) é pior. O professor vê quem ficou sem.
- As páginas prometem o comportamento novo ("a prova pausa sozinha se você sair
  da posição") — o texto anterior prometia o contrário e foi trocado junto.
- Validação combinada: `hands.absent_pct` e taxa de vídeo fragmentado por turma,
  antes × depois. Se a fragmentação subir com a vigilância ligada, desliga-se.

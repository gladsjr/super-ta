# 0020 — Queda de gravação pausa na primeira, e retomada exige liberação do professor

> **Estado:** Aceita
> **Data:** 2026-08-16

## Contexto

Nos fluxos de voz (prova oral e entrevista realtime), quando a gravação de vídeo
caía o front reiniciava o `MediaRecorder` e abria uma nova parte no servidor —
em silêncio e sem limite. O resultado era vídeo fragmentado com linha do tempo
quebrada: colar as partes desloca os tempos ("aos 32 min" deixa de apontar para
o mesmo instante), e a câmera reaberta pode mudar resolução/fps (caso
`222b9f5ef8d6`, 7 partes, issue #256).

A primeira proposta foi parar na TERCEIRA queda. Os dados de produção mataram a
ideia: de 68 envios com vídeo, 3 tinham exatamente 2 partes (uma queda) e só 2
tinham 4+ partes. Um limiar de 3 dispararia apenas nos dois casos patológicos e
deixaria passar justamente o caso comum — uma queda só, que já produz o vídeo
inutilizável. Todas as 5 quedas históricas foram em fluxo de voz; zero em 34
entrevistas por mensagem.

Além disso, retomada automática após queda era falha em aberto disfarçada: a
[ADR 0005](0005-video-obrigatorio-e-bloqueante.md) diz que o vídeo é bloqueante,
e a garantia (gravação contínua) tinha quebrado sem ninguém decidir nada.

## Decisão

Na primeira queda que interrompe a sessão de voz, a arguição pausa. A retomada é
um ato explícito do professor: ele libera UMA retomada (`resume_allowed_at`,
consumida atomicamente na reconexão — nova queda exige nova liberação) ou avalia
individualmente o que já foi gravado. O aluno vê uma tela de pausa sem linguagem
de acusação (é infraestrutura, não conduta) com a instrução de procurar o
professor. A decisão vive em fonte única (`lib/resumeGate.js`) usada pelos dois
fluxos de voz; queda durante a apresentação (sem fala do aluno) recomeça normal,
sem liberação, porque não há conteúdo gravado a proteger.

## Consequências

- Parar não é descartar: transcrição parcial e vídeo ficam salvos, e o professor
  vê onde parou (contagem de respostas) antes de decidir.
- ~7% dos envios com vídeo (18% nas provas orais, pela taxa histórica) passam a
  exigir uma ação do professor que antes não existia. É trabalho manual real —
  o custo aceito para acabar com a fragmentação silenciosa.
- Um aluno cuja gravação caiu fica parado até o professor agir. Numa prova
  síncrona com o professor ausente, isso pode significar não terminar no dia.
- Tokens de teste ficam isentos (sempre recomeçam), como em todo o gate de vídeo.
- Os vídeos multi-parte legados continuam existindo; a análise e o player já
  lidam com eles (#249/#256) — esta decisão impede os novos, não conserta os velhos.

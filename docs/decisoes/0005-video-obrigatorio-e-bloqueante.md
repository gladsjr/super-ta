# 0005 — Vídeo obrigatório e bloqueante nos três fluxos

> **Estado:** Aceita
> **Data:** 2026-08-14 (migration 072)

## Contexto

A fiscalização por vídeo falhava em aberto: se o navegador não gravasse, se a
permissão fosse revogada no meio, ou se o envio do arquivo falhasse no fim, a
sessão terminava normalmente e a submissão simplesmente ficava "sem vídeo" —
silenciosamente. Uma prova sem registro, mas concluída como se estivesse tudo
certo.

## Decisão

Quando a fiscalização está ligada, o vídeo é **obrigatório e bloqueante**, com
uma política única compartilhada pelos três fluxos e um gate em três camadas:
início (confirma a captura gravando um trecho de teste antes de conectar), meio
(perda da câmera suspende o encaminhamento do áudio) e fim (a submissão fica
aguardando vídeo até o envio chegar).

## Consequências

- Aluno com equipamento incompatível fica **barrado** — daí existir a válvula de
  escape: o professor libera individualmente.
- Surge um estado novo de submissão ("aguardando vídeo") que o painel precisa
  mostrar e que é promovido sozinho quando o envio chega.
- Mais atrito no início da sessão, em troca de não haver prova sem registro.

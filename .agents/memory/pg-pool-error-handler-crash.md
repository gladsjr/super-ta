---
name: pg pool sem 'error' handler derruba o processo inteiro
description: 'Erro HTTP intermitente que "funciona no retry" pode ser o servidor caindo; conexão ociosa do node-postgres que cai vira exit status 1 sem pool.on(error).'
---

**Sintoma → causa.** Um erro HTTP intermitente numa operação longa (ex.: pedir a
avaliação de um aluno, que faz chamada ao modelo de ~72s) que **funciona ao
repetir** frequentemente NÃO é falha transitória da API — é o **processo Node
caindo e a VM reiniciando** (o retry cai num processo novo). Confirme nos logs de
deploy: procure `Connection terminated unexpectedly` + `Unhandled 'error' event`
(pg/lib/client.js) seguido de `command finished with error [node server.js]: exit
status 1` e healthchecks 500/connection-refused logo depois (o reboot).

**Raiz.** No `node-postgres`, um cliente OCIOSO do pool continua ligado a um
backend vivo; se a conexão cair (timeout do Postgres gerenciado, blip de rede,
reciclagem), ele emite `error`. Sem `pool.on('error', …)`, o Node trata como
"unhandled 'error' event" de um EventEmitter e **relança**, matando o processo
inteiro. Operações longas pioram porque deixam conexões ociosas paradas por mais
tempo dentro da janela em que o banco/rede as recicla.

**Why:** já derrubou a produção no fluxo de avaliação por voz. É o footgun
canônico do node-postgres (documentado): todo pool precisa de listener de `error`.

**How to apply:** todo `new Pool(...)` compartilhado precisa de `pool.on('error')`
que só registra (o pool já descarta o cliente quebrado — não relance, não derrube).
`keepAlive: true` no Pool reduz a frequência das quedas de conexões ociosas.
Como rede de segurança geral, registre `process.on('unhandledRejection')` e
`uncaughtException` (log; em uncaughtException, fail-fast com `exit(1)` para a VM
reiniciar limpo). Teste barato: importe o pool e faça `pool.emit('error', new
Error('x'))` — deve logar e o processo sobreviver.

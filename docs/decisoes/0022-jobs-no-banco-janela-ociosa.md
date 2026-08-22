# 0022 — Processamento pesado vai a uma fila no banco, executada pelo app na janela ociosa

> **Estado:** Aceita
> **Data:** 2026-08-21

## Contexto

A retranscrição de auditoria do áudio contínuo (#289) criou trabalho de batch
genuíno: minutos de CPU (ffmpeg; faster-whisper local quando habilitado) que
não pertencem ao caminho da sessão. O mesmo padrão já existia no vídeo da
fiscalização. Tudo isso convive na MESMA Reserved VM do Replit que sustenta o
relay de voz em tempo real — o processo mais sensível a latência do produto.

Duas alternativas de isolamento foram estudadas e descartadas:

- **Artefatos múltiplos no mesmo projeto Replit** (app + worker Scheduled)
  exige converter o repositório em monorepo pnpm com workspaces — mudança de
  estrutura com raio de dano em todo o fluxo de build/Publish, desproporcional
  ao problema.
- **Isolamento duro de CPU** (cpuset/affinity por processo) não existe no
  contêiner do Replit: não há como cravar "realtime na CPU 0, batch na CPU 1".

## Decisão

1. **A fila vive no banco** (`jobs`, migration 078; `lib/jobs.js`):
   reivindicação atômica com `FOR UPDATE SKIP LOCKED`, lease de 90 min
   (executor morto → job volta a elegível), retentativas até `max_attempts`.
   A tabela é deliberadamente agnóstica de quem executa.
2. **O executor é o próprio app** (`lib/jobRunner.js`), num tique periódico —
   o degrau 1. Se o volume um dia exigir, o degrau 2 é um worker num projeto
   Replit **separado** consumindo a MESMA tabela; nada da fila muda.
3. **Convivência com o realtime é por prioridade, não por partição**: filhos
   de batch nascem via `lib/spawnLow.js` (nice 19 + teto de 1 thread em
   OMP/BLAS/ctranslate2 + `-threads 1` no ffmpeg). O kernel entrega CPU ao
   relay primeiro; o batch nunca ocupa a máquina.
4. **O motor local (faster-whisper) só roda na janela ociosa**: zero sessões
   de voz ativas E memória livre acima do piso (`jobs.local_min_free_mb`),
   reavaliado entre um job e outro. O motor de API roda em qualquer tique —
   é I/O, não CPU. Falha do motor local degrada para a API com log — exceção
   deliberada à [ADR 0002](0002-falhar-explicito-sem-fallback.md), que protege
   caminhos de sessão: aqui é batch de auditoria re-executável, e o resultado
   degradado é idêntico ao caminho padrão.

## Consequências

- A retranscrição deixa de rodar no encerramento da sessão (pico de carga) e
  passa a esperar a janela — minutos ou horas depois. É aceitável por design:
  o `final_transcript` é artefato de auditoria, consumido quando o professor
  avalia, não na hora ([#289](https://github.com/gladsjr/super-ta/issues/289)).
- Reprocessar um job precisa ser inócuo (idempotência por tipo): a
  retranscrição regrava `final_transcript` por inteiro.
- Se a fila estiver indisponível (migration pendente), o produtor degrada para
  o processamento inline anterior — o comportamento antigo é o fallback.

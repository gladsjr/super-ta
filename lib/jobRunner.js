// Executor de jobs na JANELA OCIOSA (issue #289, corte 3). O app é o próprio
// worker: um tique periódico reivindica jobs da fila (lib/jobs.js) e processa
// em série, com os controles moles de CPU (spawnLow: nice 19 + 1 thread) nos
// filhos pesados. Convivência com o realtime:
//
// - motor 'api': o trabalho pesado acontece no provedor — roda em qualquer
//   tique, sessão ativa ou não (é I/O, não CPU).
// - motor 'local' (faster-whisper na VM): SÓ roda com ZERO sessões de voz
//   ativas E memória livre acima do piso. A janela é reavaliada entre um job e
//   outro — aluno entrou, o executor para de reivindicar. Um job local já em
//   curso não é interrompido: nice 19 + 1 thread o mantêm inofensivo, e o
//   Linux entrega a CPU ao relay primeiro.
//
// Degrau 2 da estratégia (worker em projeto Replit separado) consome a MESMA
// tabela — este arquivo é o único que muda de lugar.

import os from "os";
import log from "./logger.js";
import { claimNextJob, completeJob, failJob } from "./jobs.js";
import { getActiveVoiceSessions } from "./realtimeBridge.js";
import { RETRANSCRIBE_ENGINE, JOBS_LOCAL_MIN_FREE_MB, JOBS_POLL_SECONDS } from "./config.js";
import { processRetranscribeJob, processRetranscribeMessageJob } from "./retranscribe.js";

const PROCESSORS = {
    retranscribe: processRetranscribeJob,                 // fluxos de voz (tee)
    retranscribe_message: processRetranscribeMessageJob,  // modo mensagem (blobs por resposta)
};

// Pura, para teste: a janela do motor local está aberta?
export function localWindowOpen({ activeSessions, freeMb, minFreeMb }) {
    return activeSessions === 0 && freeMb >= minFreeMb;
}

function windowOpen() {
    if (RETRANSCRIBE_ENGINE !== "local") return true;
    return localWindowOpen({
        activeSessions: getActiveVoiceSessions(),
        freeMb: os.freemem() / (1024 * 1024),
        minFreeMb: JOBS_LOCAL_MIN_FREE_MB,
    });
}

// Um tique: processa jobs em série enquanto a janela estiver aberta. Guarda de
// reentrância — um job mais longo que o intervalo não acumula tiques.
let running = false;
export async function tick() {
    if (running) return;
    running = true;
    try {
        while (windowOpen()) {
            const job = await claimNextJob(Object.keys(PROCESSORS));
            if (!job) break;
            try {
                const result = await PROCESSORS[job.type](job);
                await completeJob(job.id, result || null);
                log.info("JOBS", `job ${job.id} (${job.type}) concluído (tentativa ${job.attempts})`);
            } catch (err) {
                log.warn("JOBS", `job ${job.id} (${job.type}) falhou: ${err.message}`);
                await failJob(job.id, err.message);
                break; // não martela na mesma passada; a retentativa fica p/ um tique futuro
            }
        }
    } catch (err) {
        // Fila indisponível (ex.: migration 078 pendente) — só log; o produtor
        // (runRetranscribeAuto) já degradou para inline nesse cenário.
        log.error("JOBS", `tique do executor: ${err.message}`);
    } finally {
        running = false;
    }
}

export function startJobRunner() {
    const timer = setInterval(tick, JOBS_POLL_SECONDS * 1000);
    timer.unref?.(); // o executor nunca segura o shutdown do processo
    log.info("JOBS", `executor ligado (intervalo ${JOBS_POLL_SECONDS}s, motor retranscrição=${RETRANSCRIBE_ENGINE})`);
    return timer;
}

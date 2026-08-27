// Fila GLOBAL de análises de vídeo (proctoring) — issues #262 e #338.
//
// Por quê existe: o disparo automático pós-sessão (proctorAuto) roda uma
// análise por aluno que termina, sem limite — uma turma terminando junto
// disparava N pipelines concorrentes de CPU/RAM, competindo com as provas AO
// VIVO (o relay WS é sensível a latência). Foi o estouro de memória de 16/08.
//
// Desde o #338 a fila vive na TABELA `jobs` (migration 078/079) como LANE
// SEPARADA (type='video_analysis') — a mecânica (claim atômico com lease,
// dedup por submissão, prioridade, retry manual, visibilidade) é a mesma da
// retranscrição, mas as POLÍTICAS são desta lane:
//
// - PRIORIDADE: pedido manual (professor/admin) fura fila sobre o automático
//   (priority 0 vs 100); dentro da mesma classe, ordem de chegada.
// - Concorrência global configurável na tela de Operações (app_settings
//   'proctor_concurrency', default 1). Efeito imediato, sem restart.
// - DEDUP por submissão: o índice único parcial da 079 garante no banco o que
//   antes era um Map em memória; pedido manual promove a prioridade do ativo.
// - SEM retentativa automática: falhou, fica 'failed' até um humano
//   reprocessar (failJob terminal + max_attempts 1). Elimina tempestade de
//   retries contra vídeo corrompido; o contador de tentativas acumulado
//   (attemptsBase, no payload) segue sendo diagnóstico por clique.
// - O processamento roda NESTE processo (bomba própria; o tick do jobRunner
//   também bombeia, p/ jobs enfileirados por outro processo não apodrecerem).
//   O aborto do admin é cooperativo, via AbortController em memória.
// - Estado ESPELHADO em oral_voice_json.proctor_status ('queued'/'running'/
//   'failed' + attempts; #220) — as telas do professor seguem lendo dali; o
//   sucesso limpa o status e grava attempts DENTRO do relatório.
// - RECONCILIAÇÃO no boot: re-enfileira o legado órfão (queued/running de
//   restart antigo, vídeo sem relatório) — o dedup absorve duplicatas.

import * as db from "./db.js";
import { enqueueJob, claimNextJob, completeJob, failJob, reprioritizeJob, findActiveJob, getJob, listPendingJobs } from "./jobs.js";
import { analyzeOralVideoParts } from "./proctor.js";
import log from "./logger.js";

export const VIDEO_JOB_TYPE = "video_analysis";
const SETTING_KEY = "proctor_concurrency";
const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;

let concurrency = DEFAULT_CONCURRENCY;
let started = false; // a bomba só roda depois do initProctorQueue()

// Análises RODANDO neste processo: jobId -> { submissionId, token, priority,
// attempts, startedAt, ac, cancelledBy? }. Fonte do snapshot de 'running' e do
// aborto cooperativo.
const runningLocal = new Map();

const prioNum = p => (p === "manual" ? 0 : 100);
const prioName = n => (Number(n) === 0 ? "manual" : "auto");

// Enfileira (ou adere a) uma análise. Fire-and-forget: resolve quando o job
// está NA FILA (não quando conclui — para aguardar o desfecho, use
// enqueueProctorAndWait). Pedido manual promove a prioridade de um job ativo.
export async function enqueueProctor(submissionId, { priority = "auto", tokenForLog = "" } = {}) {
    const st = await db.getOralProctorStatus(submissionId).catch(() => null);
    const attemptsBase = Number(st?.attempts || 0);
    const { id, existed } = await enqueueJob(VIDEO_JOB_TYPE, {
        submissionId,
        payload: { token: tokenForLog, attemptsBase },
        maxAttempts: 1, // sem retentativa automática — reprocessar é ato humano
        priority: prioNum(priority),
    });
    if (existed && priority === "manual" && id != null) {
        await reprioritizeJob(id, 0).catch(() => {});
    }
    if (!existed) {
        await db.setOralProctorStatus(submissionId, {
            state: "queued", at: new Date().toISOString(), attempts: attemptsBase,
        }).catch(e => log.warn("PROCTORQ", `persistência do queued falhou sub=${tokenForLog || submissionId}: ${e.message}`));
    }
    pump();
    return id;
}

// Enfileira E AGUARDA o desfecho (lote "Avaliar entrevistas": a análise vem
// antes da avaliação). Poll leve do job; rejeita em falha — o chamador decide
// se a falha derruba algo (no lote, não derruba).
export async function enqueueProctorAndWait(submissionId, { tokenForLog = "", pollMs = 3000, timeoutMs = 2 * 60 * 60 * 1000 } = {}) {
    const id = await enqueueProctor(submissionId, { priority: "manual", tokenForLog });
    if (id == null) return null;
    const t0 = Date.now();
    for (;;) {
        await new Promise(r => setTimeout(r, pollMs));
        const job = await getJob(id);
        if (!job) return null;
        if (job.status === "done") return null;
        if (job.status === "failed" || job.status === "discarded") {
            throw new Error(job.last_error || "análise de vídeo falhou");
        }
        if (Date.now() - t0 > timeoutMs) throw new Error("análise de vídeo excedeu o tempo limite");
        pump(); // garante que a lane não está parada enquanto se espera
    }
}

// Cancela um item na fila OU interrompe um em execução (#272). Nos dois casos a
// submissão fica 'failed' com motivo — limpar o status faria a reconciliação do
// boot re-enfileirar, e o professor precisa VER que não há laudo (Reprocessar).
export async function cancelProctor(submissionId, who = "admin") {
    // Rodando NESTE processo: aborto cooperativo — o sinal derruba ffmpeg/
    // sidecar e o laço de quadros lança; o catch do runVideoJob persiste tudo.
    for (const item of runningLocal.values()) {
        if (item.submissionId === submissionId) {
            item.cancelledBy = who;
            item.ac?.abort();
            return true;
        }
    }
    const job = await findActiveJob(VIDEO_JOB_TYPE, submissionId);
    if (!job || job.status !== "pending") return false;
    await failJob(job.id, `cancelada pelo ${who}`, { terminal: true });
    const attemptsBase = Number(job.payload?.attemptsBase || 0);
    await db.setOralProctorStatus(submissionId, {
        state: "failed", at: new Date().toISOString(),
        error: `cancelada pelo ${who}`, attempts: attemptsBase,
    }).catch(() => {});
    return true;
}

// Fura fila (#272): item enfileirado vira prioridade manual.
export async function prioritizeProctor(submissionId) {
    const job = await findActiveJob(VIDEO_JOB_TYPE, submissionId);
    if (!job || job.status !== "pending") return false;
    return reprioritizeJob(job.id, 0);
}

async function runVideoJob(job) {
    const id = job.submission_id;
    const payload = job.payload || {};
    const tok = payload.token || id;
    const attempts = Number(payload.attemptsBase || 0) + 1;
    const item = {
        submissionId: id, token: payload.token || "", priority: prioName(job.priority),
        attempts, startedAt: Date.now(), ac: new AbortController(),
    };
    runningLocal.set(job.id, item);
    try {
        const parts = await db.getOralVideoParts(id);
        if (!parts.length) {
            // Sem vídeo (ex.: reconciliação de submissão esvaziada): não é falha.
            await db.setOralProctorStatus(id, null);
            await completeJob(job.id, { skipped: "sem vídeo" });
            return;
        }
        await db.setOralProctorStatus(id, { state: "running", at: new Date().toISOString(), attempts });
        const report = await analyzeOralVideoParts(parts, { signal: item.ac.signal });
        report.attempts = attempts;
        await db.setOralProctor(id, report); // grava e limpa o proctor_status
        await completeJob(job.id, { frames: report.frames, ms: report.ms, attempts });
        log.info("PROCTORQ", `análise ok sub=${tok} frames=${report.frames} ms=${report.ms} attempts=${attempts}${report.truncated ? " TRUNCADA(2h)" : ""}`);
    } catch (e) {
        // Interrupção deliberada ganha um motivo legível (o erro cru seria o do
        // ffmpeg morto). O attempts conta: a tentativa começou.
        const msg = item.cancelledBy ? `interrompida pelo ${item.cancelledBy}` : e.message;
        await failJob(job.id, msg, { terminal: true }).catch(() => {});
        await db.setOralProctorStatus(id, {
            state: "failed", at: new Date().toISOString(), error: msg, attempts,
        }).catch(() => {});
        log.error("PROCTORQ", `análise ${item.cancelledBy ? "interrompida" : "falhou"} sub=${tok} attempts=${attempts}: ${msg}`);
    } finally {
        runningLocal.delete(job.id);
        pump();
    }
}

// Bomba da lane: reivindica jobs de vídeo até encher a concorrência. Também é
// chamada pelo tick do jobRunner (jobs enfileirados por outro processo).
let pumping = false;
export async function pump() {
    if (!started || pumping) return;
    pumping = true;
    try {
        while (runningLocal.size < concurrency) {
            const job = await claimNextJob([VIDEO_JOB_TYPE]);
            if (!job) break;
            runVideoJob(job); // fire-and-forget: conclusão re-chama pump()
        }
    } catch (e) {
        log.error("PROCTORQ", `bomba da lane de vídeo: ${e.message}`);
    } finally {
        pumping = false;
    }
}

// Boot: carrega a concorrência persistida, reconcilia o legado e liga a bomba.
// Chamar UMA vez, depois das migrations/seeds (server.js).
export async function initProctorQueue() {
    try {
        const v = await db.getSetting(SETTING_KEY);
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY) concurrency = n;
    } catch (e) {
        log.warn("PROCTORQ", `sem app_settings ainda? usando concorrência default: ${e.message}`);
    }
    started = true;
    let reconciled = 0;
    try {
        // Legado pré-#338 (proctor_status órfão sem job) e restos de restart:
        // o dedup do banco absorve o que já tem job ativo.
        const candidates = await db.listProctorReconcileCandidates();
        for (const c of candidates) {
            await enqueueProctor(c.id, { priority: "auto", tokenForLog: c.submission_token }).catch(() => {});
            reconciled++;
        }
    } catch (e) {
        log.error("PROCTORQ", `reconciliação falhou: ${e.message}`);
    }
    log.info("PROCTORQ", `fila iniciada (lane jobs): concorrência=${concurrency}, reconciliadas=${reconciled}`);
    pump();
}

export function getProctorConcurrency() { return concurrency; }

export async function setProctorConcurrency(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > MAX_CONCURRENCY) {
        throw new Error(`concorrência deve ser um inteiro entre 1 e ${MAX_CONCURRENCY}`);
    }
    concurrency = v;
    await db.setSetting(SETTING_KEY, v);
    pump();
    return v;
}

// Fotografia da fila para a tela de Operações (ordem real de execução):
// 'running' vem da memória deste processo (quem roda vídeo é o app); 'queued'
// vem do banco — a fonte única da lane.
export async function getProctorQueueSnapshot() {
    const running = [...runningLocal.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(i => ({
            submission_id: i.submissionId, token: i.token, priority: i.priority,
            attempts: i.attempts, running_ms: Date.now() - i.startedAt,
        }));
    let queued = [];
    try {
        queued = (await listPendingJobs(VIDEO_JOB_TYPE)).map((j, idx) => ({
            submission_id: j.submission_id, token: j.payload?.token || "",
            priority: prioName(j.priority),
            attempts: Number(j.payload?.attemptsBase || 0),
            position: idx + 1, waiting_ms: Date.now() - new Date(j.created_at).getTime(),
        }));
    } catch (e) {
        log.warn("PROCTORQ", `snapshot da fila falhou: ${e.message}`);
    }
    return { concurrency, running, queued };
}

// Fila GLOBAL de análises de vídeo (proctoring) — issue #262.
//
// Por quê: o disparo automático pós-sessão (proctorAuto) roda uma análise por
// aluno que termina, sem limite — uma turma terminando junto disparava N
// pipelines concorrentes de CPU/RAM, competindo com as provas AO VIVO (o relay
// WS é sensível a latência). Foi o estouro de memória de 16/08 (vídeo de 40min,
// várias análises simultâneas).
//
// Desenho:
// - FIFO em memória com PRIORIDADE: pedido manual (professor/admin) fura fila
//   sobre o automático; dentro da mesma classe, ordem de chegada.
// - Concorrência global configurável na tela de Operações (app_settings
//   'proctor_concurrency', default 1). Efeito imediato, sem restart.
// - DEDUP por submissão: enfileirar o que já está na fila/rodando devolve a
//   promise do item existente (um pedido manual promove a prioridade).
// - SEM retentativa automática: falhou, fica 'failed' até um humano reprocessar.
//   Elimina tempestade de retries contra vídeo corrompido; 'attempts' vira
//   diagnóstico (cada tentativa é um clique deliberado).
// - Estado persistido em oral_voice_json.proctor_status ('queued'/'running'/
//   'failed' + attempts; ver #220). O sucesso limpa o status e grava attempts
//   DENTRO do relatório (contador de "reprocessos que resolveram").
// - RECONCILIAÇÃO no boot: re-enfileira queued/running órfãos de restart e o
//   legado com vídeo sem relatório — o que aposentou o lote "Analisar vídeos".
//
// A fila não precisa de tabela própria: ela é reconstruível a partir do estado
// persistido nas submissões (initProctorQueue).

import * as db from "./db.js";
import { analyzeOralVideoParts } from "./proctor.js";
import log from "./logger.js";

const SETTING_KEY = "proctor_concurrency";
const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;

let concurrency = DEFAULT_CONCURRENCY;
let started = false;          // pump só roda depois do initProctorQueue()
let seq = 0;                  // desempate estável dentro da mesma prioridade

const items = new Map();      // submissionId -> item (queued E running — dedup)
const waiting = [];           // só os queued, mantidos em ordem de execução

// item: { submissionId, tokenForLog, priority: 'manual'|'auto', seq, enqueuedAt,
//         state: 'queued'|'running', attemptsBase, startedAt?, promise, resolve, reject }

const rank = p => (p === "manual" ? 0 : 1);
function sortWaiting() {
    waiting.sort((a, b) => rank(a.priority) - rank(b.priority) || a.seq - b.seq);
}

// Enfileira (ou adere a) uma análise. Retorna promise do RELATÓRIO — rejeita na
// falha e no cancelamento. Fire-and-forget deve anexar .catch (proctorAuto anexa).
export function enqueueProctor(submissionId, { priority = "auto", tokenForLog = "" } = {}) {
    const existing = items.get(submissionId);
    if (existing) {
        // Pedido manual promove um item automático ainda na fila (fura fila).
        if (priority === "manual" && existing.priority === "auto" && existing.state === "queued") {
            existing.priority = "manual";
            sortWaiting();
        }
        return existing.promise;
    }
    const item = {
        submissionId, tokenForLog, priority, seq: seq++,
        enqueuedAt: Date.now(), state: "queued", attemptsBase: 0,
    };
    item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    // Evita unhandledRejection quando ninguém aguarda (o estado persistido é a fonte).
    item.promise.catch(() => {});
    items.set(submissionId, item);
    waiting.push(item);
    sortWaiting();
    // Persiste 'queued' com o histórico de tentativas (não incrementa aqui — a
    // tentativa só conta quando a análise COMEÇA).
    (async () => {
        try {
            const st = await db.getOralProctorStatus(submissionId);
            item.attemptsBase = Number(st?.attempts || 0);
            if (items.get(submissionId) === item && item.state === "queued") {
                await db.setOralProctorStatus(submissionId, {
                    state: "queued", at: new Date().toISOString(),
                    attempts: item.attemptsBase,
                });
            }
        } catch (e) {
            log.warn("PROCTORQ", `persistência do queued falhou sub=${tokenForLog || submissionId}: ${e.message}`);
        } finally {
            pump();
        }
    })();
    return item.promise;
}

// Cancela um item na fila OU interrompe um em execução (#272). Nos dois casos a
// submissão fica 'failed' com motivo — limpar o status faria a reconciliação do
// boot re-enfileirar, e o professor precisa VER que não há laudo (Reprocessar).
export async function cancelProctor(submissionId, who = "admin") {
    const item = items.get(submissionId);
    if (!item) return false;
    if (item.state === "running") {
        // Aborto COOPERATIVO: o sinal derruba ffmpeg/sidecar e o laço de quadros
        // lança; o catch do runItem persiste o 'failed' com este motivo.
        item.cancelledBy = who;
        item.ac?.abort();
        return true;
    }
    const idx = waiting.indexOf(item);
    if (idx >= 0) waiting.splice(idx, 1);
    items.delete(submissionId);
    await db.setOralProctorStatus(submissionId, {
        state: "failed", at: new Date().toISOString(),
        error: `cancelada pelo ${who}`, attempts: item.attemptsBase,
    });
    item.reject(new Error("análise cancelada"));
    return true;
}

// Fura fila (#272): item enfileirado vai para a CABEÇA — vira prioridade manual
// e recebe seq menor que o de qualquer outro (headSeq só decresce).
let headSeq = 0;
export function prioritizeProctor(submissionId) {
    const item = items.get(submissionId);
    if (!item || item.state !== "queued") return false;
    item.priority = "manual";
    item.seq = --headSeq;
    sortWaiting();
    return true;
}

async function runItem(item) {
    item.state = "running";
    item.startedAt = Date.now();
    item.ac = new AbortController(); // interrupção pelo admin (#272)
    const attempts = item.attemptsBase + 1;
    const id = item.submissionId, tok = item.tokenForLog || id;
    try {
        const parts = await db.getOralVideoParts(id);
        if (!parts.length) {
            // Sem vídeo (ex.: reconciliação de submissão esvaziada): não é falha.
            await db.setOralProctorStatus(id, null);
            item.resolve(null);
            return;
        }
        await db.setOralProctorStatus(id, { state: "running", at: new Date().toISOString(), attempts });
        const report = await analyzeOralVideoParts(parts, { signal: item.ac.signal });
        report.attempts = attempts;
        await db.setOralProctor(id, report); // grava e limpa o proctor_status
        log.info("PROCTORQ", `análise ok sub=${tok} frames=${report.frames} ms=${report.ms} attempts=${attempts}${report.truncated ? " TRUNCADA(2h)" : ""}`);
        item.resolve(report);
    } catch (e) {
        // Interrupção deliberada ganha um motivo legível (o erro cru seria o do
        // ffmpeg morto). O attempts conta: a tentativa começou.
        const msg = item.cancelledBy ? `interrompida pelo ${item.cancelledBy}` : e.message;
        await db.setOralProctorStatus(id, {
            state: "failed", at: new Date().toISOString(), error: msg, attempts,
        }).catch(() => {});
        log.error("PROCTORQ", `análise ${item.cancelledBy ? "interrompida" : "falhou"} sub=${tok} attempts=${attempts}: ${msg}`);
        item.reject(new Error(msg));
    } finally {
        items.delete(id);
        pump();
    }
}

function pump() {
    if (!started) return;
    const running = [...items.values()].filter(i => i.state === "running").length;
    let slots = concurrency - running;
    while (slots > 0 && waiting.length) {
        const item = waiting.shift();
        slots--;
        runItem(item); // fire-and-forget: conclusão re-chama pump()
    }
}

// Boot: carrega a concorrência persistida, reconcilia o estado do banco e liga a
// bomba. Chamar UMA vez, depois das migrations/seeds (server.js).
export async function initProctorQueue() {
    try {
        const v = await db.getSetting(SETTING_KEY);
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY) concurrency = n;
    } catch (e) {
        log.warn("PROCTORQ", `sem app_settings ainda? usando concorrência default: ${e.message}`);
    }
    let candidates = [];
    try {
        candidates = await db.listProctorReconcileCandidates();
    } catch (e) {
        log.error("PROCTORQ", `reconciliação falhou: ${e.message}`);
    }
    started = true;
    for (const c of candidates) enqueueProctor(c.id, { priority: "auto", tokenForLog: c.submission_token });
    log.info("PROCTORQ", `fila iniciada: concorrência=${concurrency}, reconciliadas=${candidates.length}`);
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

// Fotografia da fila para a tela de Operações (ordem real de execução).
export function getProctorQueueSnapshot() {
    const running = [...items.values()].filter(i => i.state === "running")
        .sort((a, b) => a.startedAt - b.startedAt);
    return {
        concurrency,
        running: running.map(i => ({
            submission_id: i.submissionId, token: i.tokenForLog, priority: i.priority,
            attempts: i.attemptsBase + 1, running_ms: Date.now() - i.startedAt,
        })),
        queued: waiting.map((i, idx) => ({
            submission_id: i.submissionId, token: i.tokenForLog, priority: i.priority,
            attempts: i.attemptsBase, position: idx + 1, waiting_ms: Date.now() - i.enqueuedAt,
        })),
    };
}

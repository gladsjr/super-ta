// Verificação de saúde, nível DEEP (#375, corte 3): uma ida real a cada
// dependência externa. Poucos segundos, poucos centavos. É o que se roda
// depois de um Publish, e o que a monitoração NÃO roda de minuto em minuto.
//
// Cada check aqui faz o que o produto faz — pela MESMA porta que o produto
// usa (sttTranscribe, synthesizeSpeech, audioStore, buildSessionConfig do
// relay) — e devolve custo real. Regras:
//   - Escreve só em chave própria (health/…) e apaga em seguida.
//   - Nunca gera resposta falada no Realtime (session.update só).
//   - Cada check tem orçamento próprio (DEEP_BUDGET_MS) e nunca pendura.
//   - "respondeu 200" ≠ "funciona": o STT compara o texto; o Realtime espera
//     o session.updated com a voz de cada trabalho ativo (#351).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { WebSocket } from "ws";
import { openai } from "./openaiClient.js";
import { putAudio, objectSize, streamRange, deleteAudio, isAvailable as storageAvailable } from "./audioStore.js";
import { sttTranscribe } from "./stt.js";
import { synthesizeSpeech } from "./audio.js";
import { computeResponsesCost, computeSttCost, computeTtsCost, meteredResponses, meteredTts } from "./billing.js";
import { buildSessionConfig } from "./realtimeBridge.js";
import { probeNativeInference } from "./proctor.js";
import { SC_SCRIPTS } from "./soundCheck.js";
import { FALLBACK_VOICE } from "../config/voices.js";
import { pool } from "../auth.js";
import {
    PROJECT_ROOT, PRINCIPAL_REASONING_MODEL, PRINCIPAL_REASONING_EFFORT,
    STT_MODEL, STT_PROVIDER, TTS_MODEL, REALTIME_MODEL, RETRANSCRIBE_ENGINE,
    HEALTH_MONTHLY_BUDGET_USD,
} from "./config.js";
import log from "./logger.js";

export const DEEP_BUDGET_MS = 30_000;

// ----------------------------------------------------------------------------
// Contabilidade (#375, corte 4). Todo check pago pendura o custo no TRABALHO
// DE SAÚDE (works.is_health, seed no boot) pelas mesmas funções de medição
// dos agentes — nada de chamada paga solta: o ledger e a reconciliação com a
// fatura fecham. O freio é MENSAL: soma do ledger no mês corrente contra
// policy.yaml#health.monthly_budget_usd. Acima de 80% avisa; em 100% os
// checks pagos viram `skip` até o dia 1 — a virada de mês zera sozinha.
export const BUDGET_WARN_PCT = 0.8;

// Trabalho de saúde e gasto do mês, numa leitura. `q` é o executor RO.
export async function healthBudgetStatus(q) {
    const w = await q(`SELECT id FROM works WHERE is_health = true LIMIT 1`);
    const workId = w.rows[0]?.id ?? null;
    let spent = 0;
    if (workId) {
        const r = await q(
            `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent FROM work_cost_events
              WHERE work_id = $1 AND created_at >= date_trunc('month', now())`, [workId]);
        spent = Number(r.rows[0]?.spent ?? 0);
    }
    const cap = HEALTH_MONTHLY_BUDGET_USD;
    const pct = cap > 0 ? spent / cap : (spent > 0 ? Infinity : 0);
    return { work_id: workId, month_spent_usd: Math.round(spent * 1e6) / 1e6, monthly_budget_usd: cap, pct: Math.round(pct * 1000) / 1000, exceeded: cap > 0 ? spent >= cap : true };
}

// Checks pagos consultam isto antes de gastar. Sem trabalho de saúde (seed
// não rodou) o check roda SEM contabilizar e diz isso — não é motivo para
// esconder o estado do provedor, mas é motivo para o check `budget` falhar.
function orcamentoPermite(ctx) {
    const o = ctx.orcamento;
    if (!o) return { ok: true, workId: null };
    if (o.exceeded) return { ok: false, reason: `orçamento mensal de saúde esgotado (US$ ${o.month_spent_usd} de ${o.monthly_budget_usd}); volta no dia 1` };
    return { ok: true, workId: o.work_id };
}
const meterCtx = (ctx, agentLabel, extra = {}) => ({ workId: ctx.orcamento?.work_id ?? null, agentLabel, ...extra });

const resultado = (status, detail = {}, cost_usd = 0) => ({ status, detail, cost_usd });
const ms = (t0) => Date.now() - t0;

// Comando externo com prazo: resolve sempre, nunca lança.
function comando(cmd, args, timeout = 15_000) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { encoding: "utf8", timeout }, (err, stdout, stderr) => {
                resolve({ ok: !err, ms: ms(t0), stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim().slice(0, 300), error: err ? (err.code || err.message) : null, timed_out: !!err?.killed });
            });
        } catch (err) { resolve({ ok: false, ms: ms(t0), error: err.message }); }
    });
}

// ----------------------------------------------------------------------------

async function checkStorage(ctx = {}) {
    // Ciclo completo numa chave própria: put → size → range → delete. Exercita
    // a passagem GCS não documentada de que o #350/#376 dependem (objectSize e
    // Range no backend do Replit): se a SDK mudar, aparece aqui, não no
    // professor tentando assistir a um vídeo. O DELETE faz parte do resultado:
    // um ciclo que grava e não apaga deixa um objeto para trás a cada execução
    // (revisão do #394). `ctx.deps.store` só existe para teste.
    const store = ctx.deps?.store ?? { putAudio, objectSize, streamRange, deleteAudio, isAvailable: storageAvailable };
    if (!store.isAvailable()) return resultado("fail", { reason: "storage indisponível (initAudioStore falhou ou não rodou)" });
    const key = `health/probe-${Date.now()}-${process.pid}.bin`;
    const bytes = Buffer.alloc(1024, 0xab);
    const t0 = Date.now();
    const etapas = { key };
    let parcial;
    try {
        const put = await store.putAudio({ key, buffer: bytes, mimetype: "application/octet-stream" });
        etapas.put_ms = ms(t0);
        if (!put.stored) return resultado("fail", { step: "put", reason: put.reason, key });
        const t1 = Date.now();
        const size = await store.objectSize(key);
        etapas.size_ms = ms(t1);
        if (size !== bytes.length) parcial = resultado("fail", { ...etapas, step: "size", expected: bytes.length, got: size });
        else {
            const t2 = Date.now();
            const stream = await store.streamRange(key, { start: 100, end: 199 });
            let lidos = 0;
            if (stream) await new Promise((res, rej) => { stream.on("data", c => lidos += c.length); stream.on("end", res); stream.on("error", rej); });
            etapas.range_ms = ms(t2);
            parcial = lidos === 100
                ? resultado(ms(t0) > 5000 ? "warn" : "ok", { ...etapas, total_ms: ms(t0) })
                : resultado("fail", { ...etapas, step: "range", expected: 100, got: lidos });
        }
    } catch (err) {
        parcial = resultado("fail", { ...etapas, error: err.message });
    }
    const t3 = Date.now();
    const del = await store.deleteAudio(key);
    if (!del.deleted) {
        log.warn("HEALTH", `sonda de storage não apagada: ${key} (${del.reason})`);
        return resultado("fail", { ...parcial.detail, step: parcial.detail.step || "delete", delete_reason: del.reason, leftover: key });
    }
    parcial.detail.delete_ms = ms(t3);
    return parcial;
}

async function checkResponses(ctx = {}) {
    // Chamada mínima ao modelo principal com o effort configurado: chave,
    // existência do modelo, aceitação do effort, latência. O effort é injetado
    // por lib/openaiClient.js, como em todo agente. Custo no trabalho de saúde
    // (meteredResponses), como em todo agente.
    const perm = orcamentoPermite(ctx);
    if (!perm.ok) return resultado("skip", { reason: perm.reason });
    const t0 = Date.now();
    const r = await meteredResponses(meterCtx(ctx, "health.responses", { model: PRINCIPAL_REASONING_MODEL }), () => openai.responses.create({
        model: PRINCIPAL_REASONING_MODEL,
        input: "Responda apenas com a palavra OK.",
        max_output_tokens: 64,
    }));
    const custo = computeResponsesCost(r.usage, PRINCIPAL_REASONING_MODEL);
    const texto = (r.output_text || "").trim();
    const status = r.status === "completed" ? (ms(t0) > 15_000 ? "warn" : "ok") : "fail";
    return resultado(status, {
        model: PRINCIPAL_REASONING_MODEL, effort: PRINCIPAL_REASONING_EFFORT, response_status: r.status, latency_ms: ms(t0),
        output: texto.slice(0, 40), tokens: { in: custo.input_tokens, out: custo.output_tokens }, billed_to_work: perm.workId,
    }, custo.cost_usd);
}

// Palavras do texto, minúsculas e sem pontuação, para comparar transcrições.
const palavras = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
    // Distância de edição por palavra — a mesma régua da calibração.
    const a = palavras(ref), b = palavras(hyp);
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return a.length ? d[a.length][b.length] / a.length : 1;
}

async function checkStt(ctx = {}) {
    // Transcreve um clip do sound check pela porta única (lib/stt.js) e COMPARA
    // com o texto esperado: é o único componente em que "respondeu 200" e
    // "funciona" divergem — mede degradação de qualidade, não só disponibilidade.
    const clip = "g2_ok";
    const esperado = SC_SCRIPTS[clip];
    const file = path.join(PROJECT_ROOT, "static/audio/soundcheck", `${clip}.mp3`);
    const buffer = await fs.promises.readFile(file);
    const perm = orcamentoPermite(ctx);
    if (!perm.ok) return resultado("skip", { reason: perm.reason });
    const t0 = Date.now();
    // meterCtx: a camada de STT (#284) grava o custo no trabalho de saúde.
    const r = await sttTranscribe({ openaiClient: openai, buffer, filename: `${clip}.mp3`, meterCtx: perm.workId ? { workId: perm.workId } : undefined });
    const erro = wer(esperado, r.text);
    const custo = computeSttCost(r.usage, r.model || STT_MODEL);
    const status = erro <= 0.2 ? "ok" : erro <= 0.5 ? "warn" : "fail";
    return resultado(status, { provider: r.provider || STT_PROVIDER, model: r.model || STT_MODEL, latency_ms: ms(t0), expected: esperado, got: r.text, wer: Math.round(erro * 1000) / 1000, threshold_ok: 0.2, billed_to_work: perm.workId }, custo.cost_usd);
}

async function checkTts(ctx = {}) {
    const perm = orcamentoPermite(ctx);
    if (!perm.ok) return resultado("skip", { reason: perm.reason });
    const texto = "Verificação de saúde do sistema.";
    const t0 = Date.now();
    const buf = await meteredTts(meterCtx(ctx, "health.tts", { model: TTS_MODEL, inputText: texto }), () => synthesizeSpeech(openai, TTS_MODEL, texto, FALLBACK_VOICE, "mp3"));
    const custo = computeTtsCost(texto, TTS_MODEL);
    // mp3: começa com "ID3" ou com um frame sync 0xFF 0xFB/0xF3/0xF2.
    const mp3 = buf.length > 100 && (buf.slice(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
    return resultado(mp3 ? (ms(t0) > 10_000 ? "warn" : "ok") : "fail", { model: TTS_MODEL, voice: FALLBACK_VOICE, bytes: buf.length, latency_ms: ms(t0), looks_like_mp3: mp3, billed_to_work: perm.workId }, custo.cost_usd);
}

async function checkVisionNative() {
    // onnxruntime-node + uma inferência real. Em ambiente sem o módulo nativo o
    // produto degrada em silêncio (proctoring pós-prova desligado); aqui não.
    try {
        const r = await probeNativeInference();
        return resultado(r.ms > 10_000 ? "warn" : "ok", r);
    } catch (err) {
        return resultado("fail", { error: err.message });
    }
}

async function checkPythonSidecar() {
    // `python -c "import mediapipe"` — hoje o sidecar de mãos falha em silêncio
    // (lib/proctor.js#runHandsSidecar). O runtime continua igual; aqui o
    // silêncio deixa de existir.
    const py = process.env.PROCTOR_PYTHON || "python";
    const r = await comando(py, ["-c", "import mediapipe, sys; print(mediapipe.__version__)"]);
    return resultado(r.ok ? "ok" : "fail", { python: py, mediapipe: r.ok ? r.stdout : null, ms: r.ms, error: r.ok ? null : (r.stderr || r.error) });
}

async function checkLocalRetranscribe() {
    // Só se o motor local estiver configurado; senão não se aplica (skip, não ok).
    if (RETRANSCRIBE_ENGINE !== "local") return resultado("skip", { reason: `retranscribe_engine=${RETRANSCRIBE_ENGINE}` });
    const bin = process.platform === "win32" ? "python" : "python3";
    const r = await comando(bin, ["-c", "import faster_whisper; print(getattr(faster_whisper, '__version__', 'ok'))"]);
    return resultado(r.ok ? "ok" : "fail", { python: bin, faster_whisper: r.ok ? r.stdout : null, ms: r.ms, error: r.ok ? null : (r.stderr || r.error) });
}

async function checkFfmpeg() {
    // Lançar binário é coisa do deep: em produção `ffmpeg -version` levou 5,8 s.
    const r = await comando("ffmpeg", ["-version"], 20_000);
    const version = r.ok ? (r.stdout.split("\n")[0] || "").replace(/^ffmpeg version\s+/, "").split(" ")[0] : null;
    return resultado(r.ok ? (r.ms > 8000 ? "warn" : "ok") : "fail", { version, ms: r.ms, error: r.ok ? null : (r.error || r.stderr), timed_out: r.timed_out });
}

// Vozes que a perna A precisa validar: a default e a de cada trabalho de voz
// ATIVO (prova oral e entrevista em tempo real). É o acidente do #351: uma voz
// que a TTS aceita e o Realtime recusa derruba o session.update inteiro.
async function vozesAtivas(q) {
    const r = await q(`SELECT DISTINCT voice FROM works
                        WHERE is_active = true AND voice IS NOT NULL
                          AND (kind = 'oral_realtime' OR interview_variant = 'realtime')`);
    const set = new Set([FALLBACK_VOICE, ...r.rows.map(x => x.voice)]);
    return [...set];
}

async function checkRealtimeA(ctx = {}) {
    // Servidor ↔ OpenAI: abre o WS do Realtime com a nossa chave, manda o MESMO
    // session.update do relay (buildSessionConfig) para cada voz, espera o
    // session.updated (ou o error, que é o que o #351 produziu). Nenhuma
    // resposta é gerada: custo essencialmente nulo.
    //
    // A lista de vozes é UMA leitura, pelo pool do health com prazo
    // (ctx.leituraRO), depois que a sequência de banco devolveu o cliente
    // (ctx.bancoLivre) — nunca pelo pool do app sem prazo, onde um pedido
    // ficaria na fila e o WS abriria depois do relatório ter voltado.
    // Silêncio, close ou error do socket rejeitam a espera; o prazo do check
    // (ctx.signal) fecha o socket. `ctx.deps` só existe para teste.
    const deps = ctx.deps ?? {};
    const WS = deps.WebSocket ?? WebSocket;
    if (ctx.bancoLivre) await ctx.bancoLivre;
    const vozes = deps.vozes ? await deps.vozes()
        : ctx.leituraRO ? await ctx.leituraRO((q) => vozesAtivas(q))
        : await vozesAtivas((sql) => pool.query(sql));
    if (ctx.signal?.aborted) throw new Error("prazo estourado antes de abrir o WS");
    const t0 = Date.now();
    const resultados = [];
    const ws = new WS(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const fila = [];
    let esperando = null; // { res, rej }
    let encerrado = null; // Error
    const encerrar = (err) => { if (encerrado) return; encerrado = err; if (esperando) { const e = esperando; esperando = null; e.rej(err); } };
    const proximoEvento = () => new Promise((res, rej) => {
        if (encerrado) return rej(encerrado);
        if (fila.length) return res(fila.shift());
        esperando = { res, rej };
    });
    ws.on("message", (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; } if (esperando) { const e = esperando; esperando = null; e.res(m); } else fila.push(m); });
    ws.on("close", (c) => encerrar(new Error(`WS fechado pela OpenAI (code=${c}) antes de confirmar a sessão`)));
    ws.on("error", (e) => encerrar(new Error(`WS erro: ${e.message}`)));
    const aoAbortar = () => { encerrar(new Error("prazo do check estourado — sonda fechada")); try { ws.close(); } catch { /* já fechado */ } };
    ctx.signal?.addEventListener("abort", aoAbortar, { once: true });
    const aberto = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); ws.once("close", (c) => rej(new Error(`fechado code=${c}`))); });
    try {
        await aberto;
        const connect_ms = ms(t0);
        let ev = await proximoEvento(); // session.created chega primeiro
        const created = ev.type === "session.created";
        for (const voice of vozes) {
            const t1 = Date.now();
            ws.send(JSON.stringify({ type: "session.update", session: buildSessionConfig({ instructions: "Sonda de saúde. Não fale.", voice, endTool: { name: "encerrar_prova", description: "sonda" } }) }));
            let resposta = null;
            while (!resposta) {
                ev = await proximoEvento();
                if (ev.type === "session.updated") resposta = { voice, ok: true, ms: ms(t1) };
                else if (ev.type === "error") resposta = { voice, ok: false, ms: ms(t1), error: ev.error?.message || JSON.stringify(ev.error).slice(0, 200) };
            }
            resultados.push(resposta);
        }
        const recusadas = resultados.filter(r => !r.ok);
        return resultado(recusadas.length ? "fail" : "ok", { model: REALTIME_MODEL, connect_ms, session_created: created, voices: resultados, total_ms: ms(t0) });
    } finally {
        ctx.signal?.removeEventListener("abort", aoAbortar);
        try { ws.close(); } catch { /* já fechado */ }
    }
}

async function checkBudget(ctx = {}) {
    // O estado do orçamento é resolvido por runHealth antes dos checks pagos
    // (ctx.orcamento); aqui ele vira linha do relatório. Sem trabalho de saúde
    // é fail: a seed não rodou, e o gasto está saindo do ledger.
    const o = ctx.orcamento;
    if (!o) return resultado("fail", { reason: "orçamento não resolvido (sem leitura do banco)" });
    if (!o.work_id) return resultado("fail", { ...o, reason: "não há trabalho de saúde (works.is_health) — seedHealthWork não rodou; o custo dos checks está fora do ledger" });
    const status = o.exceeded ? "fail" : o.pct >= BUDGET_WARN_PCT ? "warn" : "ok";
    return resultado(status, { ...o, warn_at_pct: BUDGET_WARN_PCT, resets: "dia 1 do mês (soma do ledger no mês corrente)" });
}

// Registro do nível deep. Nenhum usa o cliente de banco do health (db:false):
// o realtime_a lê a lista de vozes pelo pool do health, fora da transação.
export const DEEP_CHECKS = [
    { id: "budget",      label: "Orçamento mensal da saúde",                 level: "deep", db: false, run: checkBudget },
    { id: "storage",     label: "Storage de objetos (put/size/range/delete)", level: "deep", db: false, run: checkStorage },
    { id: "responses",   label: "Modelo principal (Responses)",               level: "deep", db: false, run: checkResponses },
    { id: "stt",         label: "Transcrição com conferência do texto",       level: "deep", db: false, run: checkStt },
    { id: "tts",         label: "Síntese de voz",                             level: "deep", db: false, run: checkTts },
    { id: "vision",      label: "Fiscalização: módulo nativo (ONNX)",         level: "deep", db: false, run: checkVisionNative },
    { id: "sidecar",     label: "Fiscalização: sidecar Python (MediaPipe)",   level: "deep", db: false, run: checkPythonSidecar },
    { id: "retranscribe_local", label: "Retranscrição local (faster-whisper)", level: "deep", db: false, run: checkLocalRetranscribe },
    { id: "ffmpeg",      label: "ffmpeg",                                     level: "deep", db: false, run: checkFfmpeg },
    { id: "realtime_a",  label: "Realtime, perna A (servidor ↔ OpenAI)",      level: "deep", db: false, run: checkRealtimeA },
].map(c => ({ ...c, budget_ms: DEEP_BUDGET_MS }));

// Estimativa de custo ANTES de rodar, para a tela dizer quanto vai custar.
export function estimateDeepCostUsd() {
    let total = 0;
    try { total += computeResponsesCost({ input_tokens: 30, output_tokens: 40 }, PRINCIPAL_REASONING_MODEL).cost_usd; } catch { /* sem preço */ }
    try { total += computeSttCost({ type: "duration", seconds: 3 }, STT_MODEL).cost_usd; } catch { /* sem preço */ }
    try { total += computeTtsCost("Verificação de saúde do sistema.", TTS_MODEL).cost_usd; } catch { /* sem preço */ }
    return Math.round(total * 1e6) / 1e6;
}

// Retranscrição pós-sessão do áudio contínuo do tee (issue #289, Fase 3 —
// CONVIVÊNCIA: gera o transcript_final de auditoria sem substituir a fonte da
// avaliação; o flip tem critério de saída próprio na estratégia).
//
// Por que funciona: o transcript ao vivo degrada porque o VAD fabrica trechos
// vazios que o STT alucina; o MESMO provedor sobre o áudio CONTÍNUO recupera o
// conteúdo (bancada #285 — a sessão 100% alucinada da Rebeca virou português
// íntegro). Corte 3 (ADR 0022): não roda mais no encerramento — vai à fila de
// jobs e o executor (lib/jobRunner.js) processa na janela ociosa; falha é
// log + estado, nunca afeta a sessão.
//
// Motores: 'api' = camada #284 (lib/stt.js, gpt-transcribe com glossário
// mecânico #293); 'local' = faster-whisper na VM (scripts/transcribe_local.py,
// custo zero) — escolha em policy.yaml#jobs.retranscribe_engine.

import { sttTranscribe } from "./stt.js";
import { classifyStudentTurn } from "./transcriptAlerts.js";
import { extractGlossary } from "./sttGlossary.js";
import { planSegments } from "./transcriptSegments.js";
import { enqueueJob } from "./jobs.js";
import { readAllBytes, extFromMimetype } from "./audioStore.js";
import { clientForWork } from "./openaiClient.js";
import { RETRANSCRIBE_ENGINE } from "./config.js";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnLow } from "./spawnLow.js";
import * as db from "./db.js";
import log from "./logger.js";

// Limite de upload da API de arquivos de áudio (25MB). O OGG do tee a ~24kbps
// fica em ~3,6MB/20min — sessões normais passam folgadas; se estourar, log e
// estado 'too_large' (o fatiamento por marcas entra num próximo corte).
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const LOCAL_MODEL = "faster-whisper-large-v3-turbo";
const LOCAL_TIMEOUT_MS = 60 * 60 * 1000; // < lease de 90min da fila

// Dispara e esquece. Corte 3 (#289): o caminho normal ENFILEIRA (jobs no banco,
// executor na janela ociosa — lib/jobRunner.js) e devolve o fôlego da máquina
// ao encerramento da sessão. Se a fila não existir/estiver indisponível
// (migration 078 pendente), degrada para o inline de antes — o buffer ainda
// está em mãos. `questions` = perguntas da sessão para o glossário mecânico.
export function runRetranscribeAuto({ submissionId, token, oggBuffer, tee, questions, workName, isBenchmark, meterCtx }) {
    const qTexts = (questions || []).map(q => (typeof q === "string" ? q : q?.question)).filter(Boolean);
    (async () => {
        if (tee?.key) {
            try {
                const jobId = await enqueueJob("retranscribe", {
                    submissionId,
                    payload: {
                        token, teeKey: tee.key,
                        teeIndex: tee.index ?? null, teeDurationS: tee.duration_s ?? null,
                        questions: qTexts, workName: workName || null,
                        isBenchmark: !!isBenchmark, meterCtx: meterCtx || null,
                    },
                });
                log.info("RETRANSCRIBE", `submission=${token}: job ${jobId} enfileirado`);
                return;
            } catch (err) {
                log.warn("RETRANSCRIBE", `fila indisponível (${err.message}) — rodando inline submission=${token}`);
            }
        }
        // Sem tee.key (upload do OGG falhou) ou fila fora: processa já, como antes.
        await retranscribe({
            submissionId, token, oggBuffer, tee, questions: qTexts, workName,
            openaiClient: clientForWork({ is_benchmark: !!isBenchmark }), meterCtx,
        });
    })().catch(err => log.error("RETRANSCRIBE", `submission=${token}: ${err.message}`));
}

// Processador do job 'retranscribe' (chamado pelo executor da fila). Relança o
// erro em falha — o executor registra e devolve o job a pending (retentativa).
export async function processRetranscribeJob(job) {
    const p = job.payload || {};
    const oggBuffer = await readAllBytes(p.teeKey);
    if (!oggBuffer || !oggBuffer.length) {
        // Objeto ausente/ilegível: erro retentável (storage pode estar instável);
        // esgotadas as tentativas, o job fica 'failed' com a causa legível.
        throw new Error(`áudio do tee ilegível no storage (key=${p.teeKey})`);
    }
    await retranscribe({
        submissionId: job.submission_id, token: p.token, oggBuffer,
        tee: { key: p.teeKey, index: p.teeIndex, duration_s: p.teeDurationS },
        questions: p.questions, workName: p.workName,
        openaiClient: clientForWork({ is_benchmark: !!p.isBenchmark }),
        meterCtx: p.meterCtx,
        allowLocal: true, // a janela ociosa já foi verificada pelo executor
    });
    return { bytes: oggBuffer?.length ?? 0 };
}

// --- MODO MENSAGEM (corte 4B, #289): retranscreve os blobs POR RESPOSTA ---
// A entrevista por mensagem não tem tee: cada resposta de áudio já é arquivada
// (student_audio_artifacts) com fronteiras naturais E o turno a que pertence.
// No encerramento, enfileira a retranscrição com o glossário do trabalho —
// corrige o REGISTRO (casos "independe"→depende) para avaliação, devolutiva e
// revisão do aluno, sem tocar no caminho síncrono da conversa.
export function runMessageRetranscribeAuto({ submissionId, token, workName, isBenchmark, meterCtx }) {
    (async () => {
        try {
            const jobId = await enqueueJob("retranscribe_message", {
                submissionId,
                payload: { token, workName: workName || null, isBenchmark: !!isBenchmark, meterCtx: meterCtx || null },
            });
            log.info("RETRANSCRIBE", `submission=${token}: job ${jobId} (mensagem) enfileirado`);
        } catch (err) {
            log.warn("RETRANSCRIBE", `fila indisponível (${err.message}) — retranscrição de mensagem inline submission=${token}`);
            await processRetranscribeMessageJob({ submission_id: submissionId, payload: { token, workName, isBenchmark, meterCtx } });
        }
    })().catch(err => log.error("RETRANSCRIBE", `mensagem submission=${token}: ${err.message}`));
}

// Processador do job 'retranscribe_message'. Idempotente (regrava o
// final_transcript inteiro); erro relançado = retentativa da fila.
export async function processRetranscribeMessageJob(job) {
    const p = job.payload || {};
    const arts = await db.listStudentAudioArtifactsForSubmission(job.submission_id);
    if (!arts.length) return { answers: 0 }; // modo texto ou sem áudio: nada a fazer

    // Glossário mecânico (#293): perguntas da conversa + nome do trabalho.
    let questionTexts = [];
    try {
        const conv = JSON.parse(await db.getConversationJson(job.submission_id));
        questionTexts = (conv?.turns || []).map(t => t?.question).filter(Boolean);
    } catch { /* sem conversa legível: glossário fica só com o nome do trabalho */ }
    const keywords = extractGlossary([p.workName, ...questionTexts].filter(Boolean));

    const openaiClient = clientForWork({ is_benchmark: !!p.isBenchmark });
    const answers = new Array(arts.length);
    let i = 0;
    async function worker() {
        while (i < arts.length) {
            const idx = i++;
            const a = arts[idx];
            const base = { audio_idx: a.audio_idx, turn_index: a.turn_index, intervention_index: a.intervention_index };
            try {
                const buf = await readAllBytes(a.object_key);
                if (!buf || !buf.length) throw new Error("áudio ilegível no storage");
                const r = await sttTranscribe({
                    openaiClient, buffer: buf,
                    filename: `retx-msg-${p.token}-a${a.audio_idx}.${extFromMimetype(a.mimetype)}`,
                    keywords: keywords.length ? keywords : null,
                    meterCtx: p.meterCtx,
                });
                answers[idx] = { ...base, text: r.text, provider: r.provider, model: r.model };
            } catch (err) {
                answers[idx] = { ...base, error: String(err.message).slice(0, 120) };
            }
        }
    }
    await Promise.all([worker(), worker()]);
    const ok = answers.filter(a => !a.error);
    if (!ok.length) throw new Error("nenhuma resposta retranscrita"); // retentável
    await db.setFinalTranscript(job.submission_id, {
        mode: "answers",
        answers,
        text: ok.map(a => a.text).join("\n"),
        provider: ok[0].provider, model: ok[0].model,
        glossary_terms: keywords.length,
        // Cobertura do modo mensagem: 1 blob = 1 resposta; falha por item conta.
        quality: withCoverage(transcriptQuality({ segments: answers }), { structured: true, parts: ok.length, expectedTurns: answers.length }),
    });
    log.info("RETRANSCRIBE", `ok(mensagem) submission=${p.token} answers=${ok.length}/${answers.length} glossario=${keywords.length}`);
    return { answers: ok.length, total: answers.length };
}

async function retranscribe({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx, allowLocal = false }) {
    if (!oggBuffer || !oggBuffer.length) return;

    const texts = [];
    if (workName) texts.push(workName);
    for (const q of questions || []) texts.push(typeof q === "string" ? q : q?.question);
    const keywords = extractGlossary(texts);

    // #312: comparador estrutural — respostas do aluno no transcript AO VIVO.
    let expectedTurns = null;
    try {
        const live = await db.getOralTranscript(submissionId);
        if (Array.isArray(live)) expectedTurns = live.filter(x => x.role === "student").length;
    } catch { /* sem transcript ao vivo: sem comparador */ }

    // Motor LOCAL (corte 3): faster-whisper na própria VM, custo zero. Só pelo
    // caminho da fila (allowLocal) — o executor garante a janela ociosa. Falha
    // (python/faster-whisper ausentes, saída vazia) degrada para a API abaixo.
    if (allowLocal && RETRANSCRIBE_ENGINE === "local") {
        try {
            await localRetranscribe({ submissionId, token, oggBuffer, tee, keywords, expectedTurns });
            return;
        } catch (err) {
            log.warn("RETRANSCRIBE", `motor local falhou (${String(err.message).slice(0, 160)}) — degradando p/ API submission=${token}`);
        }
    }

    if (oggBuffer.length > MAX_UPLOAD_BYTES) {
        log.warn("RETRANSCRIBE", `submission=${token}: ogg ${oggBuffer.length}B > limite — marcado too_large`);
        await db.setFinalTranscript(submissionId, { mode: "too_large", bytes: oggBuffer.length, tee: teePublic(tee) });
        return;
    }

    // Corte 2 (#289): FATIAMENTO POR MARCAS — cada fala do aluno vira um
    // segmento com timestamps exatos (posição de áudio das marcas do tee) e a
    // pergunta a que pertence (posicional, auditável). Índice inutilizável
    // (marcas antigas sem `b`, sessão degenerada) → modo contínuo de antes.
    const plan = planSegments(tee?.index, tee?.duration_s);
    if (plan) {
        const segments = await transcribeSegments({ oggBuffer, plan, token, keywords, openaiClient, meterCtx });
        const okSegs = segments.filter(s => !s.error);
        if (okSegs.length > 0) {
            await db.setFinalTranscript(submissionId, {
                mode: "segments",
                segments,
                text: okSegs.map(s => s.text).join("\n"),
                provider: okSegs[0].provider,
                model: okSegs[0].model,
                glossary_terms: keywords.length,
                quality: withCoverage(transcriptQuality({ segments }), { structured: true, parts: okSegs.length, expectedTurns }),
                tee: teePublic(tee),
            });
            log.info("RETRANSCRIBE", `ok submission=${token} segments=${okSegs.length}/${segments.length} glossario=${keywords.length}`);
            return;
        }
        log.warn("RETRANSCRIBE", `submission=${token}: todos os segmentos falharam — caindo p/ contínuo`);
    }

    const r = await sttTranscribe({
        openaiClient,
        buffer: oggBuffer,
        filename: `retranscricao-${token}.ogg`,
        keywords: keywords.length ? keywords : null,
        meterCtx, // custo real do trabalho — a retranscrição é parte da sessão
    });
    await db.setFinalTranscript(submissionId, {
        mode: "continuous",
        text: r.text,
        provider: r.provider,
        model: r.model,
        glossary_terms: keywords.length,
        quality: withCoverage(transcriptQuality({ text: r.text }), { structured: false, expectedTurns }),
        tee: teePublic(tee),
    });
    log.info("RETRANSCRIBE", `ok submission=${token} provider=${r.provider} chars=${r.text.length} glossario=${keywords.length}`);
}

// Fatia o OGG por segmento (ffmpeg reencode curto — Opus não corta limpo em
// -c copy no meio do frame) e transcreve cada um, com concorrência 2.
async function transcribeSegments({ oggBuffer, plan, token, keywords, openaiClient, meterCtx }) {
    const tmp = path.join(os.tmpdir(), `oratia-retx-${token}-${crypto.randomBytes(4).toString("hex")}.ogg`);
    await fs.promises.writeFile(tmp, oggBuffer);
    const results = new Array(plan.length);
    let i = 0;
    async function worker() {
        while (i < plan.length) {
            const idx = i++;
            const seg = plan[idx];
            try {
                const buf = await sliceOgg(tmp, seg.start_s, seg.end_s);
                const r = await sttTranscribe({
                    openaiClient, buffer: buf,
                    filename: `retx-${token}-s${idx}.ogg`,
                    keywords: keywords.length ? keywords : null,
                    meterCtx,
                });
                results[idx] = { ...seg, text: r.text, provider: r.provider, model: r.model };
            } catch (err) {
                // Segmento vazio/só silêncio também cai aqui (STT recusa transcrição
                // vazia) — registra e segue; o conjunto continua útil.
                results[idx] = { ...seg, error: err.message.slice(0, 120) };
            }
        }
    }
    try { await Promise.all([worker(), worker()]); }
    finally { fs.promises.unlink(tmp).catch(() => {}); }
    return results;
}

function sliceOgg(oggPath, startS, endS) {
    return new Promise((resolve, reject) => {
        const args = [
            "-v", "error", "-threads", "1",
            "-ss", String(startS), "-to", String(endS),
            "-i", oggPath,
            "-c:a", "libopus", "-b:a", "24k",
            "-f", "ogg", "pipe:1",
        ];
        const p = spawnLow("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        const out = []; let err = "";
        p.stdout.on("data", d => out.push(d));
        p.stderr.on("data", d => { err += d; });
        p.on("error", reject);
        p.on("close", code => {
            if (code === 0 && out.length) resolve(Buffer.concat(out));
            else reject(new Error(`ffmpeg slice exit=${code} ${err.slice(0, 120)}`));
        });
    });
}

// Motor local: escreve o OGG em tmp e roda scripts/transcribe_local.py
// (faster-whisper) UMA vez — com os spans do fatiamento quando o índice do tee
// permite (o modelo carrega uma vez só para todos os trechos), senão contínuo.
async function localRetranscribe({ submissionId, token, oggBuffer, tee, keywords, expectedTurns = null }) {
    const plan = planSegments(tee?.index, tee?.duration_s);
    const tmp = path.join(os.tmpdir(), `oratia-retx-local-${token}-${crypto.randomBytes(4).toString("hex")}.ogg`);
    await fs.promises.writeFile(tmp, oggBuffer);
    try {
        const args = [path.resolve("scripts", "transcribe_local.py"), "--audio", tmp, "--language", "pt"];
        if (keywords.length) args.push("--prompt", keywords.join(", "));
        if (plan) args.push("--spans", JSON.stringify(plan.map(s => [s.start_s, s.end_s])));
        const parsed = JSON.parse(await runLocalPython(args));

        if (plan && parsed.mode === "spans" && Array.isArray(parsed.results)) {
            const segments = plan.map((seg, i) => {
                const text = (parsed.results[i]?.text || "").trim();
                return text ? { ...seg, text, provider: "local", model: LOCAL_MODEL } : { ...seg, error: "vazio" };
            });
            const okSegs = segments.filter(s => !s.error);
            if (!okSegs.length) throw new Error("todos os segmentos vieram vazios");
            await db.setFinalTranscript(submissionId, {
                mode: "segments", segments,
                text: okSegs.map(s => s.text).join("\n"),
                provider: "local", model: LOCAL_MODEL,
                glossary_terms: keywords.length,
                quality: withCoverage(transcriptQuality({ segments }), { structured: true, parts: okSegs.length, expectedTurns }),
                tee: teePublic(tee),
            });
            log.info("RETRANSCRIBE", `ok(local) submission=${token} segments=${okSegs.length}/${segments.length} glossario=${keywords.length}`);
            return;
        }

        const text = (parsed.text || "").trim();
        if (!text) throw new Error("saída local vazia");
        await db.setFinalTranscript(submissionId, {
            mode: "continuous", text,
            provider: "local", model: LOCAL_MODEL,
            glossary_terms: keywords.length,
            quality: withCoverage(transcriptQuality({ text }), { structured: false, expectedTurns }),
            tee: teePublic(tee),
        });
        log.info("RETRANSCRIBE", `ok(local) submission=${token} chars=${text.length} glossario=${keywords.length}`);
    } finally {
        fs.promises.unlink(tmp).catch(() => {});
    }
}

function runLocalPython(args) {
    const bin = process.platform === "win32" ? "python" : "python3";
    return new Promise((resolve, reject) => {
        const p = spawnLow(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        const out = []; let err = "";
        const killer = setTimeout(() => { try { p.kill(); } catch { /* já morreu */ } }, LOCAL_TIMEOUT_MS);
        p.stdout.on("data", d => out.push(d));
        p.stderr.on("data", d => { err += d; });
        p.on("error", e => { clearTimeout(killer); reject(e); });
        p.on("close", code => {
            clearTimeout(killer);
            if (code === 0 && out.length) resolve(Buffer.concat(out).toString("utf8"));
            else reject(new Error(`transcribe_local exit=${code} ${err.slice(0, 200)}`));
        });
    });
}

// Monitor de captação sobre o TEE (#287 re-hospedado, corte 4): classifica
// cada trecho da retranscrição com o MESMO detector do modo mensagem e grava
// os contadores no payload. Telemetria (nunca acusa): e o criterio de saida da
// Fase 4 ("N sessoes consecutivas integras") le suspects === 0 daqui.
function transcriptQuality({ segments = null, text = "" }) {
    const parts = segments
        ? segments.filter(s => !s.error && s.text).map(s => s.text)
        : String(text || "").split(/(?<=[.!?…])\s+/).filter(x => x.trim().length > 3);
    let suspects = 0;
    for (const part of parts) if (classifyStudentTurn(part)) suspects++;
    return { parts: parts.length, suspects };
}

// #312: cobertura ESTRUTURAL — "captação íntegra" exige, além de 0 trechos
// suspeitos, que o nº de trechos cubra o nº de respostas do transcript AO VIVO
// (fronteira perdida funde duas respostas num trecho e o texto continua limpo;
// só a contagem denuncia). expectedTurns=null (sem comparador) => coverage null.
// `structured=false` (modo contínuo): sem estrutura por resposta — nunca conta
// como íntegra quando havia mais de uma resposta a cobrir.
function withCoverage(q, { structured, parts, expectedTurns }) {
    const coverage_ok = !structured
        ? (expectedTurns != null && expectedTurns > 1 ? false : null)
        : (expectedTurns == null ? null : parts >= expectedTurns);
    return { ...q, expected_turns: expectedTurns, coverage_ok };
}

function teePublic(tee) {
    if (!tee) return null;
    return { key: tee.key, duration_s: tee.duration_s, marcas: Array.isArray(tee.index) ? tee.index.length : 0 };
}

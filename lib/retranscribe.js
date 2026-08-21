// Retranscrição pós-sessão do áudio contínuo do tee (issue #289, Fase 3 —
// CONVIVÊNCIA: gera o transcript_final de auditoria sem substituir a fonte da
// avaliação; o flip tem critério de saída próprio na estratégia).
//
// Por que funciona: o transcript ao vivo degrada porque o VAD fabrica trechos
// vazios que o STT alucina; o MESMO provedor sobre o áudio CONTÍNUO recupera o
// conteúdo (bancada #285 — a sessão 100% alucinada da Rebeca virou português
// íntegro). Roda em background após o fechamento (padrão runProctorAuto):
// falha é log + estado, nunca afeta a sessão.
//
// Provedor: a camada #284 (lib/stt.js) — hoje gpt-transcribe com glossário
// mecânico das perguntas da sessão (#293); quando a config apontar Groq/local,
// esta função herda sem mudança.

import { sttTranscribe } from "./stt.js";
import { extractGlossary } from "./sttGlossary.js";
import { planSegments } from "./transcriptSegments.js";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import * as db from "./db.js";
import log from "./logger.js";

// Limite de upload da API de arquivos de áudio (25MB). O OGG do tee a ~24kbps
// fica em ~3,6MB/20min — sessões normais passam folgadas; se estourar, log e
// estado 'too_large' (o fatiamento por marcas entra num próximo corte).
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

// Dispara e esquece. `questions` = perguntas da sessão (plano/sorteio) para o
// glossário mecânico; `openaiClient` = o cliente do trabalho (benchmark ok).
export function runRetranscribeAuto({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx }) {
    retranscribe({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx })
        .catch(err => log.error("RETRANSCRIBE", `submission=${token}: ${err.message}`));
}

async function retranscribe({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx }) {
    if (!oggBuffer || !oggBuffer.length) return;
    if (oggBuffer.length > MAX_UPLOAD_BYTES) {
        log.warn("RETRANSCRIBE", `submission=${token}: ogg ${oggBuffer.length}B > limite — marcado too_large`);
        await db.setFinalTranscript(submissionId, { mode: "too_large", bytes: oggBuffer.length, tee: teePublic(tee) });
        return;
    }
    const texts = [];
    if (workName) texts.push(workName);
    for (const q of questions || []) texts.push(typeof q === "string" ? q : q?.question);
    const keywords = extractGlossary(texts);

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
            "-v", "error",
            "-ss", String(startS), "-to", String(endS),
            "-i", oggPath,
            "-c:a", "libopus", "-b:a", "24k",
            "-f", "ogg", "pipe:1",
        ];
        const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
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

function teePublic(tee) {
    if (!tee) return null;
    return { key: tee.key, duration_s: tee.duration_s, marcas: Array.isArray(tee.index) ? tee.index.length : 0 };
}

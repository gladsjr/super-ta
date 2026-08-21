// TEE de áudio do aluno no relay Realtime (issue #289, Fase 3 da estratégia).
//
// O relay já recebe cada frame PCM16 24kHz do microfone do aluno para
// encaminhar à OpenAI. Este módulo duplica essa corrente para um arquivo
// temporário em DISCO (streaming — nada acumula em RAM) e grava um ÍNDICE de
// fronteiras (fala do aluno começa/termina, resposta do examinador) com o
// relógio do próprio servidor. No fechamento da sessão, converte PCM→OGG/Opus
// (ffmpeg, ~24kbps) e sobe ao object storage.
//
// Por que existe: o transcript ao vivo é o pior registro possível quando o
// áudio degrada (o VAD fabrica trechos vazios que o STT alucina — 10 de 11
// sessões TK corrompidas), enquanto o áudio CONTÍNUO retranscrito recupera o
// conteúdo (validado na bancada #285: a sessão 100% alucinada da Rebeca virou
// português perfeito no MESMO provedor). O tee é a fonte canônica dessa
// retranscrição — com fronteiras nativas, sem alinhamento com vídeo.
//
// REGRAS DURAS (ADR 0021, transposta): o tee está FORA do caminho crítico.
// Qualquer falha (disco cheio, ffmpeg ausente, storage fora) vira log e
// desliga o tee — NUNCA exceção para o relay, NUNCA atraso no encaminhamento
// do áudio. A conversão ffmpeg roda só APÓS o fim da sessão (o relay já
// liberou). LGPD: mesmo tratamento dos áudios por resposta já arquivados
// (mesmo storage, mesma base); política de retenção na issue #290.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { putAudio } from "./audioStore.js";
import log from "./logger.js";

const SAMPLE_RATE = 24000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // PCM16 mono

export function createAudioTee({ token, scope = "TEE" }) {
    const id = crypto.randomBytes(6).toString("hex");
    const tmpPath = path.join(os.tmpdir(), `oratia-tee-${token}-${id}.pcm`);
    let stream = null;
    let dead = false;
    let bytes = 0;
    const startedAt = Date.now();
    const index = []; // [{ t_ms, type }] — relógio do servidor, relativo ao início

    function die(err, where) {
        if (dead) return;
        dead = true;
        log.error(scope, `tee morreu (${where}) submission=${token}: ${err?.message || err} — sessão segue sem tee`);
        try { stream?.destroy(); } catch { /* já era */ }
        fs.promises.unlink(tmpPath).catch(() => {});
    }

    try {
        stream = fs.createWriteStream(tmpPath);
        stream.on("error", (err) => die(err, "stream"));
    } catch (err) { die(err, "open"); }

    return {
        // Frame binário do aluno (chamado no caminho quente — precisa ser barato:
        // um write assíncrono no stream; backpressure é absorvida pelo buffer do
        // stream, nunca bloqueia o relay).
        write(buf) {
            if (dead || !stream) return;
            try { stream.write(Buffer.from(buf)); bytes += buf.length; }
            catch (err) { die(err, "write"); }
        },
        // Fronteira (speech_started/speech_stopped/examiner_done/pause/resume…).
        mark(type) {
            if (dead) return;
            index.push({ t_ms: Date.now() - startedAt, type });
        },
        get alive() { return !dead; },
        // Fecha, converte para OGG/Opus e sobe ao storage. Chamar SÓ após o fim
        // da sessão. Devolve { key, index, duration_s, bytes } ou null.
        async finish() {
            if (dead || !stream || bytes === 0) {
                fs.promises.unlink(tmpPath).catch(() => {});
                return null;
            }
            try {
                await new Promise((res, rej) => stream.end(err => err ? rej(err) : res()));
                const ogg = await pcmToOgg(tmpPath);
                const key = `tee-audio/${token}-${Date.now()}.ogg`;
                const r = await putAudio({ key, buffer: ogg, mimetype: "audio/ogg" });
                if (!r.stored) throw new Error(`storage: ${r.reason}`);
                const duration_s = Math.round((bytes / BYTES_PER_SEC) * 10) / 10;
                log.info(scope, `tee ok submission=${token} pcm=${bytes}B ogg=${ogg.length}B dur=${duration_s}s marcas=${index.length}`);
                // `ogg` segue no resultado para a retranscrição imediata não
                // precisar rebaixar do storage (o buffer já está em memória).
                return { key, index, duration_s, bytes, ogg };
            } catch (err) {
                die(err, "finish");
                return null;
            } finally {
                fs.promises.unlink(tmpPath).catch(() => {});
            }
        },
    };
}

// PCM16 24kHz mono cru → OGG/Opus ~24kbps, via ffmpeg (já presente no ambiente
// — o proctoring depende dele). Roda pós-sessão; ~20 min de áudio codificam em
// poucos segundos.
function pcmToOgg(pcmPath) {
    return new Promise((resolve, reject) => {
        const args = [
            "-v", "error",
            "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1",
            "-i", pcmPath,
            "-c:a", "libopus", "-b:a", "24k",
            "-f", "ogg", "pipe:1",
        ];
        const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        const out = [];
        let err = "";
        p.stdout.on("data", d => out.push(d));
        p.stderr.on("data", d => { err += d; });
        p.on("error", reject);
        p.on("close", code => {
            if (code === 0 && out.length) resolve(Buffer.concat(out));
            else reject(new Error(`ffmpeg exit=${code} ${err.slice(0, 200)}`));
        });
    });
}

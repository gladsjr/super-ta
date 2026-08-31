// Consolidação do vídeo da prova oral para reprodução COM SEEK (controle de tempo).
//
// Problema: o vídeo é gravado em PARTES (original + cada retomada) e cada parte é
// um WebM do MediaRecorder — que normalmente não traz duração/índice (Cues), então
// o <video> não consegue pular para um ponto ainda não carregado. Além disso, o
// player só exibia a parte 0, enquanto o proctoring calcula os timestamps sobre a
// timeline de TODAS as partes concatenadas (lib/proctor.js#analyzeOralVideoParts) —
// por isso os "trechos" (links de tempo) apontavam para fora do que era exibido.
//
// Solução: concatenar as partes num ÚNICO WebM e reescrever o container com ffmpeg
// (que recalcula a duração e grava os Cues) → vídeo seekable cuja timeline bate com
// a do proctoring. Mantém o codec original (VP8/VP9+Opus) que o navegador do
// professor JÁ reproduzia — `-c copy`, SEM re-encode: instantâneo e sem regressão de
// compatibilidade (só ADICIONA o índice que faltava). Gerado uma vez por prova e
// CACHEADO no storage.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { streamAudio, putAudio, localFilePath, objectExists } from "./audioStore.js";
import { setObjectSize } from "./db.js";
import log from "./logger.js";

const rnd = () => crypto.randomBytes(6).toString("hex");

// Materializa uma key do storage num arquivo temporário local (padrão do proctor).
async function materialize(key) {
    const ext = key.split(".").pop() || "webm";
    const tmp = path.join(os.tmpdir(), `oralvid-${rnd()}.${ext}`);
    const stream = await streamAudio(key);
    if (!stream) throw new Error(`vídeo indisponível no armazenamento: ${key}`);
    await new Promise((res, rej) => {
        const ws = fs.createWriteStream(tmp);
        stream.on("error", rej); ws.on("error", rej); ws.on("finish", res);
        stream.pipe(ws);
    });
    return tmp;
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", args);
        let err = "";
        ff.stderr.on("data", d => { err += d.toString(); });
        ff.on("error", reject);
        ff.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg saiu ${code}: ${err.slice(-400)}`)));
    });
}

// Concatena as partes (na ordem) e reescreve o container WebM com duração + Cues.
// `-c copy` (sem re-encode): rápido e preserva a qualidade/codec. Uma parte só =
// simples remux; várias = concat demuxer (partes da mesma câmera → mesmo codec).
// Retorna o Buffer do WebM consolidado.
export async function buildConsolidatedVideo(partKeys) {
    const keys = (partKeys || []).filter(Boolean);
    if (!keys.length) throw new Error("sem partes de vídeo");
    const inputs = [];
    const out = path.join(os.tmpdir(), `oralvid-out-${rnd()}.webm`);
    let listFile = null;
    try {
        for (const k of keys) inputs.push(await materialize(k));
        if (inputs.length === 1) {
            await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", inputs[0], "-c", "copy", "-y", out]);
        } else {
            // concat demuxer: lista de arquivos; ffmpeg ajusta os timestamps entre
            // segmentos gravados independentemente (cada um começa em t=0).
            listFile = path.join(os.tmpdir(), `oralvid-list-${rnd()}.txt`);
            const body = inputs.map(f => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
            await fs.promises.writeFile(listFile, body);
            await runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", out]);
        }
        return await fs.promises.readFile(out);
    } finally {
        for (const f of inputs) fs.promises.unlink(f).catch(() => {});
        fs.promises.unlink(out).catch(() => {});
        if (listFile) fs.promises.unlink(listFile).catch(() => {});
    }
}

// Key determinística do consolidado. Inclui o nº de partes: quando uma retomada
// nova chega, a key muda e o cache antigo deixa de ser servido (sem invalidação
// manual).
export function consolidatedKey(submissionToken, nParts) {
    return `oral-video/${submissionToken}-consolidated-${nParts}.webm`;
}

const inFlight = new Map(); // dedup de gerações concorrentes por key

// Garante o consolidado no storage (lazy + cache). Retorna a key consolidada, ou
// null se não der para consolidar (ex.: ffmpeg ausente / concat falhou) — o caller
// então serve a parte crua como fallback (comportamento antigo).
export async function ensureConsolidatedVideo(submissionToken, partKeys) {
    const keys = (partKeys || []).filter(Boolean);
    if (!keys.length) return null;
    const key = consolidatedKey(submissionToken, keys.length);
    if (await localFilePath(key)) return key; // já em cache (backend local)
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
        try {
            // #349: era readAllBytes(key) — baixava o consolidado INTEIRO só
            // para saber se existia, a cada requisição de vídeo. exists() não
            // transfere bytes.
            if (await objectExists(key)) return key;
            const buf = await buildConsolidatedVideo(keys);
            const r = await putAudio({ key, buffer: buf, mimetype: "video/webm" });
            if (!r.stored) { log.error("ORALVIDEO", `consolidado não armazenado token=${submissionToken}: ${r.reason}`); return null; }
            await setObjectSize(key, buf.length);   // #349: Content-Range sem baixar p/ medir
            log.info("ORALVIDEO", `consolidado ok key=${key} bytes=${buf.length} partes=${keys.length}`);
            return key;
        } catch (e) {
            log.error("ORALVIDEO", `consolidação falhou token=${submissionToken}: ${e.message}`);
            return null;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, p);
    return p;
}

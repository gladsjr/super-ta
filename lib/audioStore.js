// Adapter pra armazenamento de áudio do aluno.
//
// Esconde a SDK do Replit Object Storage por trás de uma interface mínima e
// neutra. Trocar de provedor (S3, R2, MinIO) = reescrever este arquivo.
// O resto do código consome APENAS as funções exportadas abaixo, nunca o
// formato { ok, value, error } da SDK.
//
// COMPORTAMENTO QUANDO O BUCKET NÃO ESTÁ DISPONÍVEL (dev local sem
// credenciais, ou Replit sem App Storage ativado): o adapter degrada
// graciosamente — put/delete retornam { stored: false, reason } e stream
// retorna null. NUNCA lança. A entrevista não pode quebrar por causa de
// um problema de storage acessório.
//
// CHAVES: `audio/{submission_token}/{audio_idx}.{ext}`. Esquema é estável
// e portável entre provedores S3-compatíveis.

import crypto from "node:crypto";
import log from "./logger.js";

let client = null;
let unavailableReason = null;

// Inicialização preguiçosa: tenta construir o cliente UMA vez no primeiro
// uso. Falha silenciosa cacheada — não tenta de novo a cada chamada.
async function ensureClient() {
    if (client) return client;
    if (unavailableReason) return null;
    try {
        const mod = await import("@replit/object-storage");
        client = new mod.Client();
        log.info("AUDIO_STORE", "Replit Object Storage client iniciado");
        return client;
    } catch (err) {
        unavailableReason = err.message || String(err);
        log.warn("AUDIO_STORE", `indisponível — gravação será no-op. motivo: ${unavailableReason}`);
        return null;
    }
}

export function audioKeyFor(submissionToken, audioIdx, ext = "webm") {
    // ext sem ponto, normalize qualquer entrada.
    const cleanExt = String(ext || "webm").replace(/^\./, "").toLowerCase();
    return `audio/${submissionToken}/${audioIdx}.${cleanExt}`;
}

// Heurística simples pra extrair extensão do mimetype. Cobre os formatos
// comuns que browsers entregam (webm/opus, mp4/aac, ogg, mp3, wav).
export function extFromMimetype(mimetype) {
    if (!mimetype) return "webm";
    const m = String(mimetype).toLowerCase();
    if (m.includes("webm")) return "webm";
    if (m.includes("ogg")) return "ogg";
    if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
    if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
    if (m.includes("wav")) return "wav";
    return "webm";
}

// Best-effort upload. Nunca lança. Retorna metadados úteis (key + hash)
// mesmo quando o storage está indisponível — o caller decide se registra
// nos metadados (registra só quando stored=true).
export async function putAudio({ key, buffer, mimetype = null }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { stored: false, reason: "empty_buffer", key, sha256: null };
    }
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const c = await ensureClient();
    if (!c) return { stored: false, reason: unavailableReason || "no_client", key, sha256 };
    try {
        const opts = mimetype ? { contentType: mimetype } : {};
        const r = await c.uploadFromBytes(key, buffer, opts);
        if (r.ok) {
            log.info("AUDIO_STORE", `put ok key=${key} bytes=${buffer.length}`);
            return { stored: true, key, sha256, byte_size: buffer.length };
        }
        const reason = r.error?.message || String(r.error);
        log.error("AUDIO_STORE", `put falhou key=${key}: ${reason}`);
        return { stored: false, reason, key, sha256 };
    } catch (err) {
        log.error("AUDIO_STORE", `put exception key=${key}: ${err.message}`);
        return { stored: false, reason: err.message, key, sha256 };
    }
}

// Stream de leitura pro endpoint de playback. Retorna null se o bucket
// estiver indisponível ou se o objeto não existir. Caller decide se
// responde 404 ou tenta fallback.
export async function streamAudio(key) {
    const c = await ensureClient();
    if (!c) return null;
    try {
        // downloadAsStream NÃO retorna Result — devolve o Readable direto
        // e os erros vêm como event "error" no stream.
        const stream = c.downloadAsStream(key);
        return stream;
    } catch (err) {
        log.error("AUDIO_STORE", `stream falhou key=${key}: ${err.message}`);
        return null;
    }
}

// Best-effort delete. Não lança. `notFound` não é erro (tratado como ok).
export async function deleteAudio(key) {
    const c = await ensureClient();
    if (!c) return { deleted: false, reason: unavailableReason || "no_client" };
    try {
        const r = await c.delete(key);
        if (r.ok) return { deleted: true };
        const reason = r.error?.message || String(r.error);
        // GCS retorna 404 quando o objeto já sumiu — tratamos como ok.
        if (/not\s*found|404/i.test(reason)) return { deleted: true, alreadyGone: true };
        return { deleted: false, reason };
    } catch (err) {
        return { deleted: false, reason: err.message };
    }
}

// Apaga todos os objetos sob o prefixo da submission. Usado por (a) a
// finalização explícita com solicitação de exclusão LGPD, e (b) o GC de
// retenção (scripts/audio-gc.mjs) ao processar submissions vencidas.
export async function deleteAllForSubmission(submissionToken) {
    const c = await ensureClient();
    if (!c) return { deleted: 0, errors: [unavailableReason || "no_client"] };
    const prefix = `audio/${submissionToken}/`;
    try {
        const listResult = await c.list({ prefix });
        if (!listResult.ok) return { deleted: 0, errors: [listResult.error?.message || "list_failed"] };
        const objects = listResult.value || [];
        const errors = [];
        let deleted = 0;
        for (const obj of objects) {
            const r = await deleteAudio(obj.name);
            if (r.deleted) deleted++;
            else errors.push(`${obj.name}: ${r.reason}`);
        }
        return { deleted, errors };
    } catch (err) {
        return { deleted: 0, errors: [err.message] };
    }
}

export function isAvailable() {
    return client !== null && unavailableReason === null;
}

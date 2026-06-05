// Adapter pra armazenamento de áudio do aluno.
//
// Esconde o backend de storage atrás de uma interface mínima e neutra. O resto
// do código (rotas, DB, UI, GC) consome APENAS as funções exportadas abaixo,
// nunca o formato de Result da SDK do provedor.
//
// DOIS BACKENDS, escolhidos uma vez no load (ver resolveBackendName):
//   - "local"  → filesystem, sob AUDIO_STORE_LOCAL_DIR (default <root>/.audio-store).
//                Para dev fora do Replit. É o que destrava gravação/playback local.
//   - "replit" → Replit Object Storage (@replit/object-storage). Dev e prod no
//                Replit. Comportamento idêntico ao histórico.
// Resolução: env AUDIO_STORE_BACKEND força explicitamente (fail-fast se inválido);
// senão, auto — REPL_ID presente ⇒ "replit", senão ⇒ "local". Replit dev e prod
// caem ambos em "replit"; não há necessidade de distinguir (bancos separados +
// token único já isolam — ver replit.md).
//
// COMPORTAMENTO QUANDO O BACKEND NÃO ESTÁ DISPONÍVEL (ex.: backend=replit fora do
// Replit, ou bucket não provisionado): degrada graciosamente — put/delete retornam
// { stored:false, reason } e stream retorna null. NUNCA lança em runtime. A
// entrevista não pode quebrar por um problema de storage acessório. O backend
// ativo é logado no boot (initAudioStore) pra que indisponibilidade apareça cedo,
// não como um no-op silencioso no meio da entrevista.
//
// CHAVES: `audio/{submission_token}/{audio_idx}.{ext}`. Esquema estável e portável
// entre provedores (no local viram caminhos sob o diretório base).
//
// =============================================================================
// COMO ADICIONAR UM TERCEIRO BACKEND (S3, R2, GCS, MinIO)
// =============================================================================
// Toda a portabilidade vive neste arquivo. O resto do app NÃO muda — fala só com
// { putAudio, streamAudio, deleteAudio, deleteAllForSubmission, audioKeyFor,
//   extFromMimetype, isAvailable }.
//
// 1. PROVISIONAR o bucket; credenciais por env (AWS_ACCESS_KEY_ID, etc.).
// 2. ESCREVER um buildXxxBackend() que devolva um objeto com a MESMA superfície
//    que o Client do Replit já expõe e que este arquivo consome:
//      - uploadFromBytes(key, buffer, { contentType }) → { ok, error? }
//      - downloadAsStream(key)                          → Readable | null
//      - delete(key)                                    → { ok, error? }
//      - list({ prefix })                               → { ok, value:[{name}], error? }
//    (ver localBackend abaixo como referência completa sobre fs.)
// 3. REGISTRAR o nome em KNOWN_BACKENDS e no switch de ensureClient().
// 4. CHAVES são portáveis (audio/{token}/{idx}.{ext}); `rclone sync` move os
//    objetos existentes entre provedores sem mudar o esquema. O GC
//    (scripts/audio-gc.mjs) continua igual — consome a mesma interface.
// =============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import log from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// --- Resolução do backend (uma vez, no carregamento do módulo) ----------------
const KNOWN_BACKENDS = new Set(["local", "replit"]);

function resolveBackendName() {
    const override = process.env.AUDIO_STORE_BACKEND;
    if (override) {
        const v = String(override).trim().toLowerCase();
        if (!KNOWN_BACKENDS.has(v)) {
            // Erro de config → fail-fast (diferente de falha de I/O em runtime).
            throw new Error(`AUDIO_STORE_BACKEND inválido: "${override}" (use: ${[...KNOWN_BACKENDS].join(", ")})`);
        }
        return v;
    }
    // Auto: Replit seta REPL_ID tanto no workspace (dev) quanto no deployment (prod).
    return process.env.REPL_ID ? "replit" : "local";
}

const BACKEND_NAME = resolveBackendName();
const LOCAL_DIR = path.resolve(process.env.AUDIO_STORE_LOCAL_DIR || path.join(PROJECT_ROOT, ".audio-store"));

let backend = null;
let unavailableReason = null;

// Inicialização preguiçosa: constrói o backend resolvido UMA vez no primeiro uso.
// Falha cacheada (não re-tenta a cada chamada). Local nunca falha (só garante o
// diretório); replit pode falhar (import/SDK/bucket).
async function ensureClient() {
    if (backend) return backend;
    if (unavailableReason) return null;
    try {
        backend = BACKEND_NAME === "replit" ? await buildReplitBackend() : buildLocalBackend();
        log.info("AUDIO_STORE", `client iniciado backend=${BACKEND_NAME}`);
        return backend;
    } catch (err) {
        unavailableReason = err.message || String(err);
        log.warn("AUDIO_STORE", `indisponível (backend=${BACKEND_NAME}) — gravação será no-op. motivo: ${unavailableReason}`);
        return null;
    }
}

// Força a inicialização e loga o resultado. Chamado no boot (server.js) pra que
// "storage indisponível" apareça no startup, não escondido num no-op de runtime.
export async function initAudioStore() {
    const c = await ensureClient();
    return { backend: BACKEND_NAME, available: !!c, reason: unavailableReason };
}

async function buildReplitBackend() {
    const mod = await import("@replit/object-storage");
    // O bucket é provisionado pelo App Storage e seu id chega via env
    // (DEFAULT_OBJECT_STORAGE_BUCKET_ID), tanto no workspace quanto no
    // deployment. Passamos explicitamente porque a SDK, sem a seção
    // [objectStorage] no .replit, não resolve o bucket sozinha.
    const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || undefined;
    const client = bucketId ? new mod.Client({ bucketId }) : new mod.Client();
    log.info("AUDIO_STORE", `Replit Object Storage client iniciado${bucketId ? ` bucket=${bucketId}` : ""}`);
    return client;
}

// --- Backend local (filesystem) ----------------------------------------------
// Implementa a MESMA superfície que o Client do Replit expõe, sobre fs. As chaves
// são POSIX (audio/{token}/{idx}.{ext}); path.resolve as mapeia pro caminho do SO.
function localPathFor(key) {
    const full = path.resolve(LOCAL_DIR, key);
    if (full !== LOCAL_DIR && !full.startsWith(LOCAL_DIR + path.sep)) {
        throw new Error(`chave fora do diretório base: ${key}`);
    }
    return full;
}

const localBackend = {
    async uploadFromBytes(key, buffer, _opts = {}) {
        try {
            const full = localPathFor(key);
            await fs.promises.mkdir(path.dirname(full), { recursive: true });
            await fs.promises.writeFile(full, buffer);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err };
        }
    },
    // Devolve o Readable direto (igual ao Replit), ou null se o objeto não existe
    // ou a chave é inválida — o caller (streamAudio) já trata null.
    downloadAsStream(key) {
        const full = localPathFor(key);
        if (!fs.existsSync(full)) return null;
        return fs.createReadStream(full);
    },
    async delete(key) {
        try {
            await fs.promises.unlink(localPathFor(key));
            return { ok: true };
        } catch (err) {
            if (err.code === "ENOENT") return { ok: true }; // já-removido = ok
            return { ok: false, error: err };
        }
    },
    // Lista os objetos sob um prefixo (audio/{token}/). Os objetos por token são
    // planos (sem subpastas), então um readdir de um nível basta. Retorna os
    // nomes como chaves POSIX, igual ao Replit.
    async list({ prefix = "" } = {}) {
        try {
            const dir = localPathFor(prefix);
            let entries;
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (err) {
                if (err.code === "ENOENT") return { ok: true, value: [] };
                throw err;
            }
            const base = prefix.endsWith("/") || prefix === "" ? prefix : `${prefix}/`;
            const value = entries
                .filter(e => e.isFile())
                .map(e => ({ name: `${base}${e.name}` }));
            return { ok: true, value };
        } catch (err) {
            return { ok: false, error: err };
        }
    },
};

function buildLocalBackend() {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    return localBackend;
}

// --- Interface pública (estável; consumida por rotas/GC) ----------------------

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

// Stream de leitura pro endpoint de playback. Retorna null se o backend
// estiver indisponível ou se o objeto não existir. Caller decide se
// responde 404 ou tenta fallback.
export async function streamAudio(key) {
    const c = await ensureClient();
    if (!c) return null;
    try {
        // downloadAsStream NÃO retorna Result — devolve o Readable direto
        // (ou null no local quando o objeto não existe). Erros de leitura
        // vêm como event "error" no stream.
        return c.downloadAsStream(key);
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
    return backend !== null && unavailableReason === null;
}

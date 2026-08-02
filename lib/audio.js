// Helpers de STT/TTS para a entrevista em modo áudio.
//
// Princípios (ver replit.md / CLAUDE.md):
// - Análise sempre em texto. Áudio é apenas a "última milha" da interface
//   com o aluno. Após STT, o sistema continua exatamente como hoje.
// - Áudio não é persistido em DB. Cache de TTS por sessão (no SESSIONS
//   in-memory map de server.js) com eviction LRU pequeno.
// - Fail-fast: helper joga erro; quem chama decide entre degradar para
//   texto (TTS) ou pedir nova gravação ao aluno (STT).

import OpenAI from "openai";
import log from "./logger.js";

// Retorna { text, usage, logprobs }. `usage` é opaco (Transcription.Tokens |
// Duration | undefined, conforme tipo da SDK) e fica em aberto para o caller
// ler via meteredStt(...) e calcular custo. `logprobs` é a array de
// { token, bytes, logprob } por token devolvida quando o modelo é da família
// gpt-4o-transcribe e include:["logprobs"] é pedido — usada pelo pré-gate de
// inteligibilidade (lib/audioIntelligibility.js) para detectar trechos com
// baixa confiança e disparar "pode repetir?".
//
// gpt-transcribe (jul/2026) NÃO devolve logprobs (o contrato segue: logprobs
// null ⇒ pré-gate no-op; a camada acústica client-side segue de backstop). Em
// troca aceita hints: `languages` (fixado em pt-BR, como o TTS) e `keywords`
// (termos de domínio esperados — opcional, para o caller ligar no futuro).
const LOGPROB_STT_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);

export async function transcribeAudio(client, sttModel, buffer, filename = "audio.webm", { keywords = null } = {}) {
    if (!buffer || !buffer.length) throw new Error("transcribeAudio: empty buffer");
    const file = await OpenAI.toFile(buffer, filename);
    const params = { model: sttModel, file };
    if (LOGPROB_STT_MODELS.has(sttModel)) {
        params.include = ["logprobs"];
    } else if (sttModel.startsWith("gpt-transcribe")) {
        // ISO 639-1 simples: a API rejeita código regional ("pt-BR" → 400,
        // apesar de a doc sugerir que aceita; verificado em 30/jul/2026).
        params.languages = ["pt"];
        if (Array.isArray(keywords) && keywords.length > 0) params.keywords = keywords;
    }
    const response = await log.span("AUDIO:STT", "transcriptions.create", () =>
        client.audio.transcriptions.create(params)
    );
    const text = (response?.text || "").trim();
    if (!text) throw new Error("transcribeAudio: empty transcription");
    const logprobs = Array.isArray(response?.logprobs) ? response.logprobs : null;
    log.info("AUDIO:STT", `ok logprobs=${logprobs ? logprobs.length : "—"} ${log.preview(text, 120)}`);
    return { text, usage: response?.usage, logprobs };
}

// Direção de estilo enviada ao TTS. `instructions` é só sugestão estilística
// (e tem efeito modesto, principalmente em pt-BR), então combinamos com
// `speed` — botão duro de ritmo (1.0 = padrão; 1.15 ≈ 15% mais rápido) — para
// neutralizar a leitura locucional lenta do modelo.
const TTS_STYLE_INSTRUCTIONS = [
    "Speak fast and casually, like a friend on a phone call — NOT like an announcer or audiobook narrator.",
    "Pacing: quick, with the rhythm of spontaneous everyday speech.",
    "Articulation: relaxed and connected; do NOT over-enunciate. Use the natural elisions, glides and informal phonetics of fluent everyday Brazilian Portuguese.",
    "Tone: warm, friendly, lightly curious; subtle micro-variations in pitch and energy. Avoid dramatic, theatrical or didactic delivery.",
    "Pauses: short, only where syntax demands. No long read-aloud pauses.",
    "Language: Brazilian Portuguese (pt-BR). Preserve native Brazilian phonetics.",
].join(" ");

// 1.0 = padrão. 1.15 dá um speedup perceptível sem distorcer a prosódia.
const TTS_SPEED = 1.15;

// format: "mp3" (padrão — entrevista/preview, servido por HTTP) ou "pcm"
// (PCM16 mono 24kHz cru — casa com o áudio do relay da prova oral, que fala
// PCM nos dois sentidos; usado na despedida garantida).
export async function synthesizeSpeech(client, ttsModel, text, voiceId, format = "mp3") {
    if (!text || !text.trim()) throw new Error("synthesizeSpeech: empty text");
    if (!voiceId) throw new Error("synthesizeSpeech: missing voice");
    const response = await log.span("AUDIO:TTS", "speech.create", () =>
        client.audio.speech.create({
            model: ttsModel,
            voice: voiceId,
            input: text,
            instructions: TTS_STYLE_INSTRUCTIONS,
            speed: TTS_SPEED,
            response_format: format,
        })
    );
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    log.info("AUDIO:TTS", `ok voice=${voiceId} speed=${TTS_SPEED} fmt=${format} bytes=${buffer.length} chars=${text.length}`);
    return buffer;
}

// Cache LRU bem simples para o áudio gerado por turno em uma sessão de aluno
// E também para previews de voz (chave: voiceId + hash do texto-amostra).
// Mantém no máximo `maxEntries` pares; quando estoura, descarta o mais antigo
// (por ordem de inserção, igual a um Map normal).
export class AudioCache {
    constructor(maxEntries = 10) {
        this.maxEntries = maxEntries;
        this.map = new Map();
    }
    set(key, buffer) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, buffer);
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }
    get(key) { return this.map.get(key); }
    has(key) { return this.map.has(key); }
    delete(key) { return this.map.delete(key); }
    clear() { this.map.clear(); }
    size() { return this.map.size; }
}

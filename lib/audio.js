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

export async function transcribeAudio(client, sttModel, buffer, filename = "audio.webm") {
    if (!buffer || !buffer.length) throw new Error("transcribeAudio: empty buffer");
    const file = await OpenAI.toFile(buffer, filename);
    const response = await log.span("AUDIO:STT", "transcriptions.create", () =>
        client.audio.transcriptions.create({
            model: sttModel,
            file,
        })
    );
    const text = (response?.text || "").trim();
    if (!text) throw new Error("transcribeAudio: empty transcription");
    log.info("AUDIO:STT", `ok ${log.preview(text, 120)}`);
    return text;
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

export async function synthesizeSpeech(client, ttsModel, text, voiceId) {
    if (!text || !text.trim()) throw new Error("synthesizeSpeech: empty text");
    if (!voiceId) throw new Error("synthesizeSpeech: missing voice");
    const response = await log.span("AUDIO:TTS", "speech.create", () =>
        client.audio.speech.create({
            model: ttsModel,
            voice: voiceId,
            input: text,
            instructions: TTS_STYLE_INSTRUCTIONS,
            speed: TTS_SPEED,
            response_format: "mp3",
        })
    );
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    log.info("AUDIO:TTS", `ok voice=${voiceId} speed=${TTS_SPEED} bytes=${buffer.length} chars=${text.length}`);
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

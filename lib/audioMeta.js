// Probe leve para extrair duração (segundos) de um buffer de áudio sem
// decodificar o conteúdo — lê só os headers/frames via music-metadata.
//
// Por que existir: a OpenAI STT API ora devolve usage como tokens, ora como
// duration, dependendo do modelo/response_format. Em vez de depender disso,
// medimos localmente do próprio buffer (WebM/Opus do aluno, MP3 do TTS).
// Roda em sub-ms para arquivos típicos de mensagem de voz.

import { parseBuffer } from "music-metadata";
import log from "./logger.js";

export async function getAudioDurationSeconds(buffer, hintMime = null) {
    if (!buffer || !buffer.length) return null;
    try {
        const opts = hintMime ? { mimeType: hintMime } : undefined;
        const meta = await parseBuffer(buffer, opts);
        const sec = meta?.format?.duration;
        if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) return sec;
        return null;
    } catch (err) {
        log.warn("AUDIO", `duration probe failed (mime=${hintMime ?? "?"}): ${err.message}`);
        return null;
    }
}

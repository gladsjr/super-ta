// Narrator de orientação: TTS de um script fixo (config/narrator_intro.txt)
// que toca antes do entrevistador, com voz aleatória DIFERENTE da voz dele.
//
// Objetivo: cobrir a espera entre upload do PDF e o início real da arguição
// com algo útil — explicar como a entrevista funciona, sinalizar que esse
// "agente" NÃO é o entrevistador, e remeter ao botão Instruções (que quase
// ninguém clica). Só faz sentido em modo áudio; em texto é no-op.

import fs from "fs";
import path from "path";
import { PROJECT_ROOT, TTS_MODEL } from "./config.js";
import { VOICES } from "../config/voices.js";
import { openai } from "./openaiClient.js";
import { synthesizeSpeech } from "./audio.js";
import { meteredTts } from "./billing.js";
import { getAudioDurationSeconds } from "./audioMeta.js";
import log from "./logger.js";

const NARRATOR_SCRIPT_PATH = path.join(PROJECT_ROOT, "config", "narrator_intro.txt");

const NARRATOR_SCRIPT = fs.readFileSync(NARRATOR_SCRIPT_PATH, "utf-8").trim();
if (!NARRATOR_SCRIPT) {
    throw new Error("config/narrator_intro.txt está vazio");
}

export function loadNarratorScript() {
    return NARRATOR_SCRIPT;
}

// Escolhe uma voz aleatória da pool excluindo a voz do entrevistador desta
// sessão, para deixar AUDITIVAMENTE claro que não é a mesma pessoa.
export function pickNarratorVoice(excludeVoiceId) {
    const candidates = VOICES.filter(v => v.id !== excludeVoiceId);
    const pool = candidates.length > 0 ? candidates : VOICES;
    return pool[Math.floor(Math.random() * pool.length)].id;
}

// Gera o áudio do narrator e guarda em sess.narratorAudio. Idempotente por
// sessão: segunda chamada devolve o mesmo resultado sem custo. Em modo texto
// devolve null. Em caso de falha de TTS, devolve { audio_error } — o frontend
// degrada silenciosamente (não bloqueia a entrevista).
export async function attachNarratorAudio(sess, meterCtx) {
    if (sess.interactionMode !== "audio") return null;
    if (sess.narratorAudio?.buffer) {
        return {
            audio_url: sess.narratorAudio.url,
            audio_duration_seconds: sess.narratorAudio.durationSec,
            voice_id: sess.narratorAudio.voiceId,
        };
    }
    const text = loadNarratorScript();
    const voiceId = pickNarratorVoice(sess.voice);
    try {
        const buffer = await meteredTts(
            { ...meterCtx, model: TTS_MODEL, inputText: text },
            () => synthesizeSpeech(sess.openai || openai, TTS_MODEL, text, voiceId)
        );
        const durationSec = await getAudioDurationSeconds(buffer, "audio/mpeg");
        const url = `/s/${encodeURIComponent(sess.submissionToken)}/narrator-audio`;
        sess.narratorAudio = { buffer, voiceId, durationSec, url };
        log.info("NARRATOR", `voice=${voiceId} duration=${typeof durationSec === "number" ? durationSec.toFixed(1) : "?"}s bytes=${buffer.length}`);
        return { audio_url: url, audio_duration_seconds: durationSec, voice_id: voiceId };
    } catch (err) {
        log.error("NARRATOR", `TTS failed: ${err.message}`);
        return { audio_error: "tts_failed", voice_id: voiceId };
    }
}

// Atalho de STT com a config do runtime (issue #284).
//
// Vive separado de lib/sttProvider.js de propósito: config.js importa o
// sttProvider (para validar provedores no boot), então o binding com a config
// precisa ficar num terceiro módulo para não criar ciclo.
//
// Uso: sttTranscribe({ openaiClient, buffer, filename, keywords?, meterCtx? })
//   → { text, usage, logprobs, quality, provider, model }
// Com a config padrão (openai, sem fallback/sombra) o caminho é idêntico ao
// transcribeAudio histórico.

import { transcribe } from "./sttProvider.js";
import {
    STT_MODEL, STT_PROVIDER, STT_FALLBACK_PROVIDER, STT_GROQ_MODEL,
    STT_TIMEOUT_MS, STT_SHADOW_PROVIDER, STT_SHADOW_RATE,
} from "./config.js";

const CFG = {
    provider: STT_PROVIDER,
    fallbackProvider: STT_FALLBACK_PROVIDER,
    sttModel: STT_MODEL,
    groqModel: STT_GROQ_MODEL,
    timeoutMs: STT_TIMEOUT_MS,
    shadowProvider: STT_SHADOW_PROVIDER,
    shadowRate: STT_SHADOW_RATE,
};

export function sttTranscribe(call) {
    return transcribe(CFG, call);
}

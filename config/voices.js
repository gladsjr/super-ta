// Lista fixa de vozes disponíveis para o entrevistador no modo áudio.
// IDs correspondem aos voice ids da OpenAI.
//
// gender é informativo (não afeta a TTS); útil para a UI sugerir alinhamento
// com a persona do entrevistador caso o professor queira esse cuidado.
//
// `realtime: false` marca voz que a API de TTS aceita mas o modelo REALTIME
// REJEITA (#351). A rejeição não é local: a OpenAI recusa o `session.update`
// INTEIRO, e a arguição rodava com a personalidade padrão do provedor, em inglês,
// sem as questões e sem a ferramenta de encerramento. Por isso o catálogo deixou
// de ser único: quem escolhe voz para prova oral ou entrevista em tempo real só
// pode ver as compatíveis.
//
// Ordem reflete a UX: vozes "expressivas" do gpt-4o-mini-tts primeiro — elas
// respondem melhor a `instructions` e soam mais conversacionais. As vozes
// herdadas do tts-1 (alloy/shimmer/nova/echo/onyx/sage) ficam no fim porque
// tendem a soar locucionais.
export const VOICES = [
    // Expressivas (gpt-4o-mini-tts)
    { id: "coral",   label: "Coral — feminina, calorosa e expressiva",  gender: "f",      realtime: true  },
    { id: "ash",     label: "Ash — masculina, madura e calma",          gender: "m",      realtime: true  },
    { id: "ballad",  label: "Ballad — masculina, expressiva",           gender: "m",      realtime: true  },
    { id: "verse",   label: "Verse — neutra, expressiva e articulada",  gender: "neutro", realtime: true  },
    { id: "marin",   label: "Marin — feminina, suave",                  gender: "f",      realtime: true  },
    { id: "cedar",   label: "Cedar — masculina, grave",                 gender: "m",      realtime: true  },
    // Herdadas do tts-1 (mais locucionais)
    { id: "alloy",   label: "Alloy — neutra, clara",                    gender: "neutro", realtime: true  },
    { id: "shimmer", label: "Shimmer — feminina, calorosa",             gender: "f",      realtime: true  },
    { id: "nova",    label: "Nova — feminina, articulada",              gender: "f",      realtime: false },
    { id: "echo",    label: "Echo — masculina, sóbria",                 gender: "m",      realtime: true  },
    { id: "onyx",    label: "Onyx — masculina, grave",                  gender: "m",      realtime: false },
    { id: "sage",    label: "Sage — neutra, reflexiva",                 gender: "neutro", realtime: true  },
];

const VOICE_IDS = new Set(VOICES.map(v => v.id));
const REALTIME_IDS = new Set(VOICES.filter(v => v.realtime).map(v => v.id));

// Voz usada quando a escolhida é inválida ou incompatível. Tem de ser realtime.
export const FALLBACK_VOICE = "verse";

export function isValidVoice(id) {
    return typeof id === "string" && VOICE_IDS.has(id);
}

// Serve para prova oral e entrevista em tempo real? (#351)
export function isRealtimeVoice(id) {
    return typeof id === "string" && REALTIME_IDS.has(id);
}

// As vozes oferecidas para um uso. `realtime` filtra as incompatíveis.
export function voicesFor({ realtime = false } = {}) {
    return realtime ? VOICES.filter(v => v.realtime) : VOICES;
}

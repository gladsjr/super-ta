// Lista fixa de vozes disponíveis para o entrevistador no modo áudio.
// IDs correspondem aos voice ids da OpenAI TTS API.
//
// gender é informativo (não afeta a TTS); útil para a UI sugerir alinhamento
// com a persona do entrevistador caso o professor queira esse cuidado.

// Ordem reflete a UX: vozes "expressivas" do gpt-4o-mini-tts primeiro — elas
// respondem melhor a `instructions` e soam mais conversacionais. As vozes
// herdadas do tts-1 (alloy/shimmer/nova/echo/onyx/sage) ficam no fim porque
// tendem a soar locucionais.
export const VOICES = [
    // Expressivas (gpt-4o-mini-tts)
    { id: "coral",   label: "Coral — feminina, calorosa e expressiva",  gender: "f" },
    { id: "ash",     label: "Ash — masculina, madura e calma",          gender: "m" },
    { id: "ballad",  label: "Ballad — masculina, expressiva",           gender: "m" },
    { id: "verse",   label: "Verse — neutra, expressiva e articulada",  gender: "neutro" },
    { id: "marin",   label: "Marin — feminina, suave",                  gender: "f" },
    { id: "cedar",   label: "Cedar — masculina, grave",                 gender: "m" },
    // Herdadas do tts-1 (mais locucionais)
    { id: "alloy",   label: "Alloy — neutra, clara",                    gender: "neutro" },
    { id: "shimmer", label: "Shimmer — feminina, calorosa",             gender: "f" },
    { id: "nova",    label: "Nova — feminina, articulada",              gender: "f" },
    { id: "echo",    label: "Echo — masculina, sóbria",                 gender: "m" },
    { id: "onyx",    label: "Onyx — masculina, grave",                  gender: "m" },
    { id: "sage",    label: "Sage — neutra, reflexiva",                 gender: "neutro" },
];

const VOICE_IDS = new Set(VOICES.map(v => v.id));

export function isValidVoice(id) {
    return typeof id === "string" && VOICE_IDS.has(id);
}

// Camada acústica do pré-gate de áudio. Diferente de lib/audioIntelligibility.js
// (que olha os logprobs do STT — análise de back-end, cega ao "confidently-wrong"),
// aqui mapeamos métricas ACÚSTICAS do sinal (front-end, cegas ao conteúdo) para
// os mesmos três tiers — seguir / avisar / repetir — e as combinamos com o tier
// de logprob por SEVERIDADE-MÁXIMA.
//
// Por que front-end (no waveform): o caso "música alta → nome errado, com alta
// confiança" é invisível ao logprob por construção (o modelo está confiante
// porque "decidiu"). Mas é visível no SINAL: SNR baixo / ruído de fundo
// intrusivo. Validado empiricamente no test bed (FLEURS+GTZAN): um gate de SNR
// pega exatamente esse modo de falha, com falso-positivo ~0 em áudio limpo.
//
// As métricas são calculadas NO NAVEGADOR (PCM do microfone está lá de graça;
// o servidor só recebe webm/opus e não há ffmpeg para decodificar). Portanto
// são reportadas pelo cliente — confiáveis o bastante para um aviso cooperativo
// de UX; o gate de logprob (server-side, à prova de adulteração) é o backstop.
//
// Cutpoints iniciais vêm da calibração sintética (jun/2026); a forma correta é
// refinar com logs reais (os [AUDIO:Acoustic] registram os valores crus).

export const TIER_RANK = { seguir: 0, avisar: 1, repetir: 2 };

// Métrica em que MENOR = pior (vale para energy-SNR e DNSMOS-BAK), com cutpoints
// { warn, repeat } e repeat < warn. Valor ausente/inválido → "seguir" (voto mudo).
function lowerWorseTier(value, warn, repeat) {
    if (value == null || !Number.isFinite(value)) return "seguir";
    if (value < repeat) return "repetir";
    if (value < warn) return "avisar";
    return "seguir";
}

export function snrTier(snrDb, pol) {
    return lowerWorseTier(snrDb, pol.snr_warn, pol.snr_repeat);
}

export function bakTier(bak, pol) {
    return lowerWorseTier(bak, pol.bak_warn, pol.bak_repeat);
}

// votes: Array<{ tier, source }>. Devolve { tier, sources } do tier mais severo
// (com todas as fontes que votaram nesse tier, p/ auditoria/log). Votos "seguir"
// não entram em `sources`.
export function combineTiers(votes) {
    let best = { tier: "seguir", sources: [] };
    for (const v of votes) {
        const r = TIER_RANK[v.tier] ?? 0;
        const cur = TIER_RANK[best.tier] ?? 0;
        if (r > cur) best = { tier: v.tier, sources: [v.source] };
        else if (r === cur && r > 0) best.sources.push(v.source);
    }
    return best;
}

// Avalia só a parte acústica (SNR + BAK opcional) a partir das métricas cruas
// reportadas pelo cliente. Devolve { tier, sources, tiers } — `tiers` traz o
// voto individual de cada sinal, útil para log.
export function classifyAcoustic({ snr, bak }, pol) {
    const votes = [];
    const tiers = {};
    if (pol.snr_enabled && snr != null) {
        tiers.snr = snrTier(snr, pol);
        votes.push({ tier: tiers.snr, source: "snr" });
    }
    if (pol.bak_enabled && bak != null) {
        tiers.bak = bakTier(bak, pol);
        votes.push({ tier: tiers.bak, source: "bak" });
    }
    return { ...combineTiers(votes), tiers };
}

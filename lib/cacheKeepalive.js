// Keep-alive do cache de prompt (opt-in via policy.yaml#prompt_cache.keepalive_seconds).
//
// Motivação (diagnóstico jul/2026): os misses anômalos do gpt-5.6-terra crescem
// com o GAP entre turnos (3% a 20-40s → 47% a 2,5min), e a economia favorece o
// ping: 1 miss evitado custa P×5,375/Mtok (input cheio + regravação) enquanto 1
// ping que acerta o cache custa P×0,25/Mtok — ou seja, 1 miss evitado paga ~21
// pings, independentemente do tamanho do prefixo.
//
// Desenho v1 (zero risco de poluição): o ping repete APENAS as `instructions` da
// última chamada do orquestrador (com dedup ligado, é o grosso do prefixo:
// preâmbulo + regras + agenda + análise + plano) + um input trivial, SEM o
// parâmetro `conversation` — nada é apensado ao histórico. Ele mantém quente a
// entrada de cache das instructions e a aderência de roteamento da
// prompt_cache_key. Se o mecanismo do miss for eviction da entrada longa
// (instructions+histórico), o ping converte miss total em hit parcial; se for
// perda de aderência de roteamento, tende a prevenir o miss inteiro. (v2, se
// preciso: ping com `conversation` + store:false — exige validar que não polui.)
//
// Ciclo de vida: agendado após cada resposta do orquestrador (o aluno está
// pensando); cancelado quando o aluno responde (/chat), no finalize e após
// MAX_PINGS_PER_GAP (aluno abandonou — não pingar para sempre).

import { PRINCIPAL_REASONING_MODEL, PROMPT_CACHE_KEEPALIVE_SEC } from "./config.js";
import { meteredResponses } from "./billing.js";
import { openai } from "./openaiClient.js";
import log from "./logger.js";

const MAX_PINGS_PER_GAP = 8;

export function cancelKeepalive(sess) {
    if (sess?._kaTimer) {
        clearInterval(sess._kaTimer);
        sess._kaTimer = null;
    }
}

// instructions: o finalSystemPrompt da última chamada (agent expõe em
// parsed._keepalivePrompt). meterCtx: { workId, submissionId, openai } — o ping
// é contabilizado no ledger com agentLabel CACHE_KEEPALIVE (mensurável à parte;
// as análises de miss filtram por %Orchestrator% e não o veem).
export function scheduleKeepalive(sess, instructions, meterCtx) {
    if (!PROMPT_CACHE_KEEPALIVE_SEC || !instructions) return;
    cancelKeepalive(sess);
    let fires = 0;
    sess._kaTimer = setInterval(async () => {
        if (++fires > MAX_PINGS_PER_GAP || sess.conversationCompleted) {
            cancelKeepalive(sess);
            return;
        }
        try {
            const client = meterCtx?.openai || sess.openai || openai;
            await meteredResponses(
                { ...(meterCtx || {}), agentLabel: "CACHE_KEEPALIVE", model: PRINCIPAL_REASONING_MODEL },
                () => client.responses.create({
                    model: PRINCIPAL_REASONING_MODEL,
                    instructions,
                    input: [{ role: "user", content: "(keep-alive de cache: responda apenas OK)" }],
                    max_output_tokens: 16,
                    // explícito → o wrapper de effort não injeta o medium; barato.
                    reasoning: { effort: "none" },
                    ...(meterCtx?.workId ? { prompt_cache_key: `iv:${meterCtx.workId}` } : {}),
                })
            );
            log.debug("CACHE_KEEPALIVE", `ping ${fires}/${MAX_PINGS_PER_GAP} sess=${sess.submissionToken}`);
        } catch (err) {
            log.warn("CACHE_KEEPALIVE", `ping falhou (segue sem): ${err.message}`);
        }
    }, PROMPT_CACHE_KEEPALIVE_SEC * 1000);
    sess._kaTimer.unref?.();
}

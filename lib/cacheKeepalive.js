// Keep-alive do cache de prompt, v2 "ping camaleão" (opt-in via
// policy.yaml#prompt_cache.keepalive_seconds).
//
// Lição do v1 (reprovado): o cache casa por MAIOR-PREFIXO-COMUM; um ping sem
// `conversation`/tools mantinha viva uma trilha DISJUNTA da que o turno real
// precisa (pings a 92% de hit, turnos reais a 37% de miss mesmo assim).
//
// v2 (ideia do Gladstone): o ping renderiza um prefixo BYTE-IDÊNTICO ao do
// turno real — MESMAS instructions (com o preâmbulo de ping do agente), MESMA
// conversation, MESMAS tools (file_search) e a MESMA prompt_cache_key. Toda a
// informação que o distingue vai no FIM do input: "[É PING]" (o turno real
// termina com "[NÃO É PING]"). O preâmbulo instrui o modelo a responder apenas
// "ok" quando vir [É PING]; reforçamos com reasoning none + max_output 16.
// `store: false` garante que NADA é apensado à conversation (validado
// empiricamente em 25/jul: itens antes == depois). Assim o ping toca
// exatamente a entrada de cache que o próximo turno real vai procurar.
//
// Custo: prefixo em cache a 0,25/Mtok → ~$0,01/ping em 40k; um ping que acha o
// prefixo frio o REAQUECE (paga o write — que é justamente o serviço prestado).
//
// Ciclo de vida: agendado após cada resposta do orquestrador (aluno pensando);
// cancelado quando o aluno responde (/chat), no finalize (conversationCompleted)
// e após MAX_PINGS_PER_GAP (abandono não vira ping infinito).

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

// ka: { instructions, conversationId, vectorStoreId } — exposto pelo agente em
// parsed._keepalive (o espelho exato da última chamada real). meterCtx:
// { workId, submissionId, openai } — ping contabilizado com agentLabel
// CACHE_KEEPALIVE (análises de miss filtram %Orchestrator% e não o veem).
export function scheduleKeepalive(sess, ka, meterCtx) {
    if (!PROMPT_CACHE_KEEPALIVE_SEC || !ka?.instructions || !ka?.conversationId) return;
    cancelKeepalive(sess);
    let fires = 0;
    sess._kaTimer = setInterval(async () => {
        if (++fires > MAX_PINGS_PER_GAP || sess.conversationCompleted) {
            cancelKeepalive(sess);
            return;
        }
        try {
            const client = meterCtx?.openai || sess.openai || openai;
            const payload = {
                model: PRINCIPAL_REASONING_MODEL,
                instructions: ka.instructions,
                input: [{ role: "user", content: "[É PING]" }],
                conversation: ka.conversationId,
                // NÃO gravar: o ping não pode entrar no histórico (validado: com
                // store:false a conversation fica intocada).
                store: false,
                // SEM reasoning explícito: o wrapper do openaiClient injeta o MESMO
                // effort do turno real (medium). CRÍTICO: o effort faz parte do
                // prefixo do cache (medido em 25/jul: payload idêntico com effort
                // trocado = cached 0; igual = 99,8%) — ping com effort diferente
                // manteria uma trilha disjunta (o erro do v2.0). O preâmbulo de
                // ping limita a resposta a "ok"; o teto abaixo segura o resto.
                max_output_tokens: 128,
            };
            // Mesmas tools do turno real — a lista de tools faz parte do prefixo
            // renderizado; sem ela o prefixo divergiria (lição do v1).
            if (ka.vectorStoreId) {
                payload.tools = [{ type: "file_search", vector_store_ids: [ka.vectorStoreId] }];
            }
            if (meterCtx?.workId) payload.prompt_cache_key = `iv:${meterCtx.workId}`;
            await meteredResponses(
                { ...(meterCtx || {}), agentLabel: "CACHE_KEEPALIVE", model: PRINCIPAL_REASONING_MODEL },
                () => client.responses.create(payload)
            );
            log.debug("CACHE_KEEPALIVE", `ping ${fires}/${MAX_PINGS_PER_GAP} sess=${sess.submissionToken}`);
        } catch (err) {
            log.warn("CACHE_KEEPALIVE", `ping falhou (segue sem): ${err.message}`);
        }
    }, PROMPT_CACHE_KEEPALIVE_SEC * 1000);
    sess._kaTimer.unref?.();
}

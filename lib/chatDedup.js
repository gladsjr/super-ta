// Idempotência do /chat da entrevista.
//
// Artefato real que motivou isto: um retry de transporte (fetch reexecutado
// após falha de rede) reenviou a MESMA mensagem do aluno e o servidor a
// processou como turno novo — pergunta duplicada no registro, a primeira sem
// resposta (1 caso em 181 entrevistas de teste). A correção: o cliente manda um
// `client_msg_id` por AÇÃO de envio (retries reusam o id) e o servidor decide
// aqui o que fazer com repetições. Sem id (cliente antigo), tudo segue como
// antes — a decisão é sempre "process".
//
// Deliberadamente NÃO deduplicamos por texto: respostas curtas idênticas em
// sequência ("sim", "ok") são legítimas numa entrevista.

/** Idade a partir da qual um in_flight é considerado morto (o processamento
 *  caiu sem marcar done nem abortar) e um reenvio pode reprocessar. */
export const IN_FLIGHT_STALE_MS = 180_000;

/**
 * Decide o destino de uma chegada no /chat.
 *
 * @param {{id:string,status:"in_flight"|"done",at:number,result:object|null}|null} prev
 *        estado de dedupe da sessão (sess.chatDedup)
 * @param {string|null} id  client_msg_id da requisição (null = cliente sem id)
 * @param {number} now      Date.now()
 * @returns {{decision:"process"|"replay"|"reject_in_flight", next:object|null}}
 *   process           → processar normalmente; gravar `next` em sess.chatDedup
 *   replay            → repetição de turno JÁ concluído; responder `next.result`
 *   reject_in_flight  → repetição enquanto o original ainda processa; 409
 */
export function decideChatDedup(prev, id, now) {
    if (!id) return { decision: "process", next: prev ?? null };
    if (prev && prev.id === id) {
        if (prev.status === "done") return { decision: "replay", next: prev };
        if (now - prev.at < IN_FLIGHT_STALE_MS) return { decision: "reject_in_flight", next: prev };
        // in_flight velho: o processamento original morreu — deixa reprocessar.
    }
    return { decision: "process", next: { id, status: "in_flight", at: now, result: null } };
}

/** Marca o turno como concluído, guardando o payload para eventual replay.
 *  No-op se o id não confere (ex.: cliente sem id). Retorna o novo estado. */
export function markChatDone(prev, id, payload, now) {
    if (!id || !prev || prev.id !== id) return prev ?? null;
    return { id, status: "done", at: now, result: payload };
}

/** Aborta o in_flight (erro respondido ao cliente): libera reenvio imediato
 *  do mesmo id. Retorna o novo estado. */
export function abortChatDedup(prev, id) {
    if (!id || !prev || prev.id !== id || prev.status !== "in_flight") return prev ?? null;
    return null;
}

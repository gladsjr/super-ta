import * as db from "./db.js";

// Leitura e remoção do log da conversa (visível ao professor). A *escrita*
// passa por db.persistSubmissionState (UPDATE atômico que combina o log com
// as colunas de runtime). Ver lib/sessionState.js.

export async function readConversationLog(submissionId) {
    const text = await db.getConversationJson(submissionId);
    return text ? JSON.parse(text) : null;
}

export async function deleteConversationLog(submissionId) {
    await db.setConversationJson(submissionId, null);
}

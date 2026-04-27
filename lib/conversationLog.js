import * as db from "./db.js";

// Persists the conversation log (turns + interventions + persona + intro etc.)
// as a serialized JSON string in the submissions row. Atomicity comes from the
// single UPDATE — no tmp/rename dance needed.

export async function writeConversationLog(submissionId, payload) {
    await db.setConversationJson(submissionId, JSON.stringify(payload, null, 2));
}

export async function readConversationLog(submissionId) {
    const text = await db.getConversationJson(submissionId);
    return text ? JSON.parse(text) : null;
}

export async function deleteConversationLog(submissionId) {
    await db.setConversationJson(submissionId, null);
}

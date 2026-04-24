import fs from "fs";
import path from "path";

export const CONVERSATION_LOG_FILENAME = "conversation.json";

export function conversationLogPath(submissionFullPath) {
    return path.join(submissionFullPath, CONVERSATION_LOG_FILENAME);
}

// Atomic write: serialize, write to .tmp, rename over target. Failure is logged
// by the caller but never throws — persistence must not break the interview.
export function writeConversationLog(submissionFullPath, payload) {
    const target = conversationLogPath(submissionFullPath);
    const tmp = target + ".tmp";
    const body = JSON.stringify(payload, null, 2);
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, target);
}

export function readConversationLog(submissionFullPath) {
    const target = conversationLogPath(submissionFullPath);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, "utf8"));
}

export function deleteConversationLog(submissionFullPath) {
    const target = conversationLogPath(submissionFullPath);
    if (fs.existsSync(target)) fs.unlinkSync(target);
}

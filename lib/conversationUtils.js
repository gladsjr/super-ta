// Helpers compartilhados de manipulação de conversação:
// - Leitura/log de items da Conversations API (OpenAI).
// - Construção de turnos a partir do plano.
// - Serialização do conversation_json (visível ao professor).
// - Persistência atômica (conversation_json + 5 colunas de runtime).
//
// Sem estado próprio — todas as funções operam sobre `sess` ou conversationId.

import * as db from "./db.js";
import { openai } from "./openaiClient.js";
import { dehydrate } from "./sessionState.js";
import log from "./logger.js";

export async function getConversationContext(conversationId, limit = 12, client = openai) {
    const page = await client.conversations.items.list(conversationId, { limit });
    const items = page?.data || [];
    const lines = items
        .filter(item => item?.type === "message")
        .map(item => {
            const text = (item.content || [])
                .map(part => (part && typeof part.text === "string") ? part.text : "")
                .filter(Boolean)
                .join("\n");
            if (!text) return null;
            return `${item.role}: ${text}`;
        })
        .filter(Boolean);
    return lines.reverse().join("\n");
}

export function extractItemText(item) {
    if (item?.type !== "message") return null;
    return (item.content || [])
        .map(part => (part && typeof part.text === "string") ? part.text : "")
        .filter(Boolean)
        .join("\n");
}

// Log do item mais recente apendado a uma conversation (DEBUG only).
// Evita despejar o histórico inteiro a cada turno; payloads de DocumentMap
// e EVALUATION SIGNALS são resumidos, não reimpressos.
export async function logLastConvItem(conversationId, scope, client = openai) {
    if (!log.enabled("debug")) return;
    try {
        const page = await client.conversations.items.list(conversationId, { limit: 1, order: "desc" });
        const item = page?.data?.[0];
        if (!item) return;
        if (item.type !== "message") {
            log.debug(scope, `+${item.type || "unknown"}`);
            return;
        }
        const text = extractItemText(item) || "";
        if (text.startsWith("[DOCUMENT_MAP]")) {
            log.debug(scope, `+${item.role} [DOCUMENT_MAP] (stored, ${text.length} chars)`);
            return;
        }
        if (text.startsWith("[EVALUATION SIGNALS]")) {
            log.debug(scope, `+${item.role} [EVALUATION SIGNALS] (stored, ${text.length} chars)`);
            return;
        }
        log.debug(scope, `+${item.role} ${log.preview(text, 140)}`);
    } catch (err) {
        log.debug(scope, `logLastConvItem failed: ${err.message}`);
    }
}

// Dump completo da conversation (TRACE only — opt-in para debug profundo).
export async function logFullConv(conversationId, scope, limit = 20, client = openai) {
    if (!log.enabled("trace")) return;
    const page = await client.conversations.items.list(conversationId, { limit });
    const items = page?.data || [];
    const lines = items.map((item, index) => {
        if (item?.type === "message") {
            const text = extractItemText(item);
            return `${index + 1}. [${item.role}] ${log.preview(text, 200)}`;
        }
        return `${index + 1}. [${item?.type || "unknown"}]`;
    });
    log.trace(scope, `full conv (${items.length} items)\n${lines.join("\n")}`);
}

// Constrói um objeto de turno a partir de uma pergunta do plano. answer e
// answered_at são preenchidos depois quando o aluno responde.
export function turnFromPlanQuestion(index, q) {
    return {
        index,
        question: q?.question ?? "",
        rationale: q?.rationale ?? null,
        answer: null,
        asked_at: new Date().toISOString(),
        answered_at: null,
        question_metadata: {
            id: q?.id ?? null,
            objectives: q?.objectives ?? [],
            concerns: q?.concerns ?? [],
            decision_criteria: q?.decision_criteria ?? [],
            information_needs: q?.information_needs ?? [],
            evaluation_mode: q?.evaluation_mode ?? [],
        },
    };
}

// Serializa o log visível ao professor a partir da sessão viva.
export function buildConversationLogPayload(sess) {
    return {
        submission_token: sess.submissionToken,
        work_token: sess.workToken,
        student_label: sess.studentLabel ?? null,
        interviewer_persona: sess.interviewerPersona ?? null,
        intro: {
            messages: sess.introLog ?? [],
            transitioned_at: sess.introTransitionedAt ?? null,
        },
        started_at: sess.conversationStartedAt ?? null,
        updated_at: new Date().toISOString(),
        completed: !!sess.conversationCompleted,
        document_map: sess.documentMap ?? null,
        turns: sess.turnLog ?? [],
        // Telemetria de latência por resposta do entrevistador (modo áudio).
        // Um registro por turno do super-orquestrador; ver recordTurnTimings.
        server_timings: sess.serverTimings ?? [],
        skipped_questions: sess.skippedQuestions ?? [],
        // Despedida durável (B): { message, completion_reason, finalize_reason, at }.
        // Sem isto, a fala de encerramento só existia na resposta ao vivo do /chat
        // e sumia se a conexão caísse — nunca chegava à revisão do aluno nem ao log.
        finalization: sess.finalization ?? null,
    };
}

// Best-effort. UPDATE atômico que combina conversation_json (log visível ao
// professor) com as 5 colunas de runtime (necessárias para retomada após
// restart). Falha não pode abortar a entrevista.
export async function persistConversationLog(sess) {
    try {
        const payload = buildConversationLogPayload(sess);
        const runtime = dehydrate(sess);
        await db.persistSubmissionState(sess.submissionId, {
            conversationJsonText: JSON.stringify(payload, null, 2),
            currentPhase: runtime.currentPhase,
            questionIndex: runtime.questionIndex,
            frozenInteractionMode: runtime.frozenInteractionMode,
            frozenVoice: runtime.frozenVoice,
            runtimeState: runtime.runtimeState,
        });
    } catch (err) {
        log.error("LOG", `persist conversation failed submission=${sess.submissionToken}: ${err.message}`);
    }
}

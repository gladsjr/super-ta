// Hidratação/desidratação pura do estado de runtime de uma entrevista.
// Sem rede, sem DB, sem fs — só transformação de objetos. Permite testar a
// serialização sem subir nada.
//
// Cinco campos "quentes" são colunas dedicadas em submissions (queryáveis e
// com CHECK constraints): current_phase, question_index, frozen_interaction_mode,
// frozen_voice, e o JSONB opaco runtime_state_json. O JSONB tem schema_version
// porque vai ser durável e o shape pode evoluir.

import { AudioCache } from "./audio.js";

export const RUNTIME_SCHEMA_VERSION = 1;

// Extrai do `sess` em memória os campos que precisam sobreviver a restart.
// Tudo que pode ser reconstruído da conversation_json (turnLog, introLog,
// interventionsPersona, skippedQuestions, etc.) NÃO entra no runtime — fica
// na conversation_json mesmo.
export function dehydrate(sess) {
    return {
        currentPhase: sess.currentPhase ?? null,
        questionIndex: typeof sess.questionIndex === "number" ? sess.questionIndex : null,
        frozenInteractionMode: sess.interactionMode ?? null,
        frozenVoice: sess.voice ?? null,
        runtimeState: {
            schema_version: RUNTIME_SCHEMA_VERSION,
            conversation_id_chat: sess.conversationId_chat ?? null,
            conversation_id_eval: sess.conversationId_eval ?? null,
            vector_store_id: sess.vectorStoreId ?? null,
            openai_file_id: sess.openaiFileId ?? null,
            interview_plan: sess.interviewPlan ?? null,
            interviewer_yaml_snapshot: sess.interviewerYamlText ?? null,
            document_map: sess.documentMap ?? null,
            audio_turn_id_counter: typeof sess.audioTurnIdCounter === "number" ? sess.audioTurnIdCounter : 0,
        },
    };
}

// Monta um sess a partir do que veio do banco. Validação estrutural só (presença
// de schema_version e IDs essenciais). Validação semântica (recursos OpenAI ainda
// existem) é do server.js.
export function hydrate({ submission, work, runtimeRow, conversationLog, systemPrompt }) {
    const rs = runtimeRow.runtime_state ?? null;
    if (!rs || rs.schema_version !== RUNTIME_SCHEMA_VERSION) {
        throw new Error(`hydrate: runtime_state ausente ou em versão incompatível (${rs?.schema_version ?? "null"})`);
    }
    const interviewerPersona = conversationLog?.interviewer_persona ?? null;
    if (!interviewerPersona) {
        throw new Error("hydrate: conversation_json sem interviewer_persona");
    }
    const turnLog = Array.isArray(conversationLog.turns) ? conversationLog.turns : [];
    const introLog = Array.isArray(conversationLog.intro?.messages) ? conversationLog.intro.messages : [];
    const { conv_chat, conv_eval } = rebuildConvFromLog(conversationLog);

    return {
        systemPrompt,
        submissionToken: submission.submission_token,
        workToken: work.work_token,
        workId: work.id,
        submissionId: submission.id,
        conversationId_chat: rs.conversation_id_chat,
        conversationId_eval: rs.conversation_id_eval,
        conv_chat,
        conv_eval,
        history: conv_chat,
        documentMap: rs.document_map ?? null,
        submissionPath: conversationLog ? "<resumed>" : null,
        openaiFileId: rs.openai_file_id ?? null,
        vectorStoreId: rs.vector_store_id ?? null,
        currentPhase: runtimeRow.current_phase ?? "awaiting_upload",
        questionIndex: runtimeRow.question_index ?? 0,
        questionCount: turnLog.length,
        interviewerPersona,
        interviewerYamlText: rs.interviewer_yaml_snapshot ?? null,
        interviewPlan: rs.interview_plan ?? null,
        introLog,
        introTransitionedAt: conversationLog?.intro?.transitioned_at ?? null,
        turnLog,
        skippedQuestions: Array.isArray(conversationLog.skipped_questions) ? conversationLog.skipped_questions : [],
        conversationStartedAt: conversationLog.started_at ?? null,
        conversationCompleted: !!conversationLog.completed,
        interviewPreparation: null,
        preparationInputs: null,
        interviewPreparationError: null,
        interactionMode: runtimeRow.frozen_interaction_mode ?? "text",
        voice: runtimeRow.frozen_voice ?? null,
        audioCache: new AudioCache(10),
        audioTurnIdCounter: rs.audio_turn_id_counter ?? 0,
        lastInterviewerAudio: null,
        resumed: true,
        rebuilt: false,
        rebuildReason: null,
    };
}

// Replay do log persistido (visível ao professor) reconstruindo as duas
// "conversation arrays" que o server.js usa em memória. A ordem é:
//   intro.messages (em ordem) → para cada turn: pergunta (assistant),
//   interventions[i] (user+assistant), e a answer (user) se já houver.
//
// É o melhor esforço de espelhar a sequência visível ao aluno. Não precisa
// bater 1:1 com o conv_chat remoto antigo (que é descartado no rebuild);
// precisa só ter o suficiente para a UI re-renderizar o histórico.
export function rebuildConvFromLog(conversationLog) {
    const conv_chat = [];
    const conv_eval = [];

    const introMessages = Array.isArray(conversationLog?.intro?.messages) ? conversationLog.intro.messages : [];
    for (const m of introMessages) {
        if (!m || !m.role || typeof m.content !== "string") continue;
        conv_chat.push({ role: m.role, content: m.content });
        conv_eval.push({ role: m.role, content: m.content, metadata: { phase: "intro" } });
    }

    const turns = Array.isArray(conversationLog?.turns) ? conversationLog.turns : [];
    for (const t of turns) {
        if (typeof t?.question === "string" && t.question) {
            conv_chat.push({ role: "assistant", content: t.question });
            conv_eval.push({ role: "assistant", content: t.question, metadata: { turn: t.index ?? null } });
        }
        const interventions = Array.isArray(t?.interventions) ? t.interventions : [];
        for (const iv of interventions) {
            // Meta interventions são "channel=modal" e por contrato NÃO aparecem
            // no conv_chat visível (ver server.js /chat handler, ramo meta).
            const isModal = iv?.channel === "modal";
            if (typeof iv?.student_message === "string" && iv.student_message && !isModal) {
                conv_chat.push({ role: "user", content: iv.student_message });
            }
            if (typeof iv?.student_message === "string" && iv.student_message) {
                conv_eval.push({ role: "user", content: iv.student_message, metadata: { intervention: iv.type ?? null } });
            }
            if (typeof iv?.assistant_response === "string" && iv.assistant_response && !isModal) {
                conv_chat.push({ role: "assistant", content: iv.assistant_response });
            }
            if (typeof iv?.assistant_response === "string" && iv.assistant_response) {
                conv_eval.push({ role: "assistant", content: iv.assistant_response, metadata: { intervention: iv.type ?? null } });
            }
        }
        if (typeof t?.answer === "string" && t.answer) {
            conv_chat.push({ role: "user", content: t.answer });
            conv_eval.push({ role: "user", content: t.answer, metadata: { turn: t.index ?? null } });
        }
    }

    return { conv_chat, conv_eval };
}

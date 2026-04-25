// Formatting helpers shared by agents that operate on the local interview
// state (the three triage agents and the relevance agent). These only format
// locally-known state into prompt blocks. No remote fetching — we don't want
// these calls to pollute the student-facing conversation stored in the
// Conversations API.

function listOrDash(items) {
    if (!Array.isArray(items) || items.length === 0) return "—";
    return items.map(x => `  - ${x}`).join("\n");
}

export function formatQuestionBlock(currentTurn) {
    if (!currentTurn) return "(nenhuma pergunta ativa)";
    const m = currentTurn.question_metadata || {};
    return [
        `Pergunta (#${(currentTurn.index ?? 0) + 1}): ${currentTurn.question ?? ""}`,
        `Justificativa: ${currentTurn.rationale ?? "—"}`,
        `Objectives:\n${listOrDash(m.objectives)}`,
        `Concerns:\n${listOrDash(m.concerns)}`,
        `Decision criteria:\n${listOrDash(m.decision_criteria)}`,
        `Information needs:\n${listOrDash(m.information_needs)}`,
        `Evaluation mode:\n${listOrDash(m.evaluation_mode)}`,
    ].join("\n");
}

export function formatTurnHistoryBlock(currentTurn) {
    if (!currentTurn) return "(sem histórico)";
    const lines = [`agente: ${currentTurn.question ?? ""}`];
    const interventions = Array.isArray(currentTurn.interventions) ? currentTurn.interventions : [];
    for (const iv of interventions) {
        lines.push(`aluno: ${iv.student_message ?? ""}`);
        lines.push(`agente [${iv.type}]: ${iv.assistant_response ?? ""}`);
    }
    return lines.join("\n");
}

// Renders every recorded turn — questions, mid-turn interventions, and final
// answers — into a single text block. Used by the relevance agent when it
// needs to judge the next planned question against everything said so far.
export function formatFullConversation(turnLog) {
    if (!Array.isArray(turnLog) || turnLog.length === 0) return "(conversa vazia)";
    const blocks = turnLog.map(turn => {
        const lines = [`--- Turno ${(turn.index ?? 0) + 1} ---`];
        lines.push(`agente: ${turn.question ?? ""}`);
        const interventions = Array.isArray(turn.interventions) ? turn.interventions : [];
        for (const iv of interventions) {
            lines.push(`aluno: ${iv.student_message ?? ""}`);
            lines.push(`agente [${iv.type}]: ${iv.assistant_response ?? ""}`);
        }
        if (turn.answer != null) {
            lines.push(`aluno: ${turn.answer}`);
        } else {
            lines.push(`(aluno ainda não respondeu)`);
        }
        return lines.join("\n");
    });
    return blocks.join("\n\n");
}

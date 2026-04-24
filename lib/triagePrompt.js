// Formatting helpers shared by the three triage agents. These only format
// locally-known state (the current turn + its interventions) into prompt
// blocks. No remote fetching — we don't want triage calls to pollute the
// student-facing conversation stored in the Conversations API.

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

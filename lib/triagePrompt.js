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

// Lista numerada das interventions do turno corrente, com o que o aluno
// disse e o que o agente respondeu a cada uma. Existe separada de
// formatFullConversation para tornar saliente — para o AnswerSufficiencyAgent
// — quantas tentativas o agente já fez neste turno sobre a mesma lacuna.
// Sem isso, o agente precisa contar mentalmente em meio ao histórico geral
// e tende a perder a noção de "estou em retornos decrescentes".
export function formatCurrentTurnInterventions(currentTurn) {
    const interventions = Array.isArray(currentTurn?.interventions) ? currentTurn.interventions : [];
    if (interventions.length === 0) return "(nenhuma intervenção anterior neste turno — esta é a primeira resposta do aluno à pergunta do turno)";

    const header = `(${interventions.length} ${interventions.length === 1 ? "intervenção anterior" : "intervenções anteriores"} neste turno)`;
    const items = interventions.map((iv, i) => {
        const n = i + 1;
        const type = iv.type ?? "?";
        const tag = type === "follow_up"
            ? `follow_up — issue=${iv.issue ?? "?"}`
            : `${type}${typeof iv.intensity === "number" ? ` — intensity=${iv.intensity}` : ""}`;
        const studentLine = iv.student_message ? `aluno: "${iv.student_message}"` : "aluno: (sem mensagem)";
        const agentLine = iv.assistant_response ? `agente: "${iv.assistant_response}"` : "agente: (sem resposta)";
        return `${n}. [${tag}]\n   ${studentLine}\n   ${agentLine}`;
    });
    return `${header}\n${items.join("\n")}`;
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

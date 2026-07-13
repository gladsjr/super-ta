function historyText(history) {
    return history.length ? history.map((item) => `${item.role === "interviewer" ? "Entrevistador" : "Aluno"}: ${item.text}`).join("\n") : "(inicio da entrevista)";
}

function versionedInstruction(value) {
    return value && !String(value).includes("@") ? `\n\nINSTRUCOES VERSIONADAS DO SETUP:\n${value}` : "";
}

export function candidatePrompt(testCase, turn, evidenceText, setupPrompts = {}) {
    return `AREA: ${testCase.large_area} > ${testCase.area}\nNIVEL: ${testCase.course_level || "nao informado"}\n\nPERSONA DA PESSOA ENTREVISTADORA:\n${testCase.persona.description}\n\nEVIDENCIAS RECUPERADAS DO ENUNCIADO E DO TRABALHO:\n${evidenceText}\n\nHISTORICO ATE O ESTADO CONGELADO:\n${historyText(turn.history)}\nAluno: ${turn.student_message}${versionedInstruction(setupPrompts.candidate)}\n\nGere a melhor proxima fala da pessoa entrevistadora.`;
}

export function judgePrompt(testCase, turn, pair, evidenceText, setupPrompts = {}) {
    return `CONTEXTO DO CASO\nArea: ${testCase.large_area} > ${testCase.area}\nPersona: ${testCase.persona.description}\nEvidencias recuperadas:\n${evidenceText}\nHistorico:\n${historyText(turn.history)}\nAluno: ${turn.student_message}\n\nINTENCOES PEDAGOGICAS ESPERADAS\n${turn.expected_intents.map((item) => `- ${item}`).join("\n")}\n\nCONTRADICOES OU RISCOS CONHECIDOS\n${(turn.known_contradictions || []).map((item) => `- ${item}`).join("\n") || "- Nenhum especifico."}${versionedInstruction(setupPrompts.judge)}\n\nRUBRICA TECNICA MINIMA\nAvalie relevancia, profundidade, uso do contexto, fidelidade a persona, adequacao do follow-up, naturalidade e possibilidade de resposta oral sem calculos inviaveis.\n\nRESPOSTA A\n${pair.A}\n\nRESPOSTA B\n${pair.B}\n\nRetorne exatamente este formato:\n{"winner":"A|B|tie","score":-1.0,"dimensions":{"relevance":-1.0,"context_use":-1.0,"persona_fidelity":-1.0,"follow_up":-1.0,"oral_answerability":-1.0},"confidence":0.0,"critical_failure":false,"rationale":"texto curto"}\n\nEm score e dimensions, -1 significa que A e claramente pior que B, 0 equivale e +1 significa que A e claramente melhor que B. winner deve ser coerente com esse sinal.`;
}

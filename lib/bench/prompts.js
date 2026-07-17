function historyText(history) {
    return history?.length ? history.map((item) => `${item.role === "interviewer" ? "Entrevistador" : "Aluno"}: ${item.text}`).join("\n") : "(inicio da entrevista)";
}

function versionedInstruction(title, value) {
    return value ? `\n\n${title}:\n${value}` : "";
}

function caseContext(testCase, evidenceText) {
    return `AREA: ${testCase.large_area} > ${testCase.area}\nNIVEL: ${testCase.course_level || "não informado"}\n\nENUNCIADO:\n${testCase.assignment}\n\nTRABALHO DO ALUNO:\n${testCase.student_work}\n\nPERSONA DA PESSOA ENTREVISTADORA:\n${testCase.interviewer_persona.description}\n\nPERSONA DO ALUNO:\n${testCase.student_persona.description}\n\nPONTOS DE INVESTIGAÇÃO:\n${testCase.investigation_points}\n\nPLANO DE ENTREVISTA:\n${JSON.stringify(testCase.interview_plan, null, 2)}\n\nEVIDÊNCIAS RECUPERADAS:\n${evidenceText}`;
}

export function candidatePrompt(testCase, turn, evidenceText, setupPrompts = {}) {
    return `${caseContext(testCase, evidenceText)}\n\nHISTORICO ATE O ESTADO CONGELADO:\n${historyText(turn.history)}\nAluno: ${turn.student_message}\n\nMEMORIA ANTES DA DECISAO:\n${JSON.stringify(turn.memory_before || {}, null, 2)}\n\nMETADADOS DA ENTRADA:\n${JSON.stringify(turn.input_metadata || {}, null, 2)}${versionedInstruction("RUBRICA VERSIONADA DO SETUP", setupPrompts.candidate)}\n\nDecida a proxima acao do superorquestrador. A fala deve ser natural e ter um foco, mas a saida deve conter tambem a decisao, a justificativa de auditoria e a memoria atualizada.`;
}

export function judgePrompt(testCase, turn, pair, evidenceText, setupPrompts = {}) {
    return `${caseContext(testCase, evidenceText)}\n\nHISTORICO:\n${historyText(turn.history)}\nAluno: ${turn.student_message}\n\nMEMORIA ANTERIOR:\n${JSON.stringify(turn.memory_before || {}, null, 2)}\n\nPOLITICA CANONICA DO ESTADO:\n${JSON.stringify(turn.canonical.policy, null, 2)}\n\nINTENCOES E RISCOS CONHECIDOS:\n${JSON.stringify({ expected_intents: turn.canonical.expected_intents || [], known_risks: turn.canonical.known_risks || [] }, null, 2)}${versionedInstruction("RUBRICA VERSIONADA DE JULGAMENTO", setupPrompts.judge)}\n\nCompare as saidas completas. Primeiro avalie se a decisao de acao e adequada; depois a fala, a coerencia entre decisao e fala, a atualizacao de memoria, o contexto, a persona e a possibilidade de resposta oral. Nao favoreca a referencia por ser referencia.\n\nSAIDA A\n${JSON.stringify(pair.A, null, 2)}\n\nSAIDA B\n${JSON.stringify(pair.B, null, 2)}\n\nEm score e dimensoes, -1 significa que A e claramente pior, 0 equivale e +1 significa que A e claramente melhor. winner deve ser coerente com o sinal.`;
}

export function studentSimulationPrompt(testCase, state, history, interviewerMessage, setupPrompts = {}) {
    return `${caseContext(testCase, "Não se aplica à simulação do aluno.")}\n\nHISTÓRICO:\n${historyText(history)}\nEntrevistador: ${interviewerMessage}\n\nOBJETIVO RELACIONADO:\n${state.objective_id}\n\nCOMPORTAMENTO DESTE ESTADO:\n${state.behavior}\n\nORIENTAÇÃO FACTUAL DA RESPOSTA:\n${state.response_guidance}${versionedInstruction("INSTRUÇÕES VERSIONADAS PARA SIMULAÇÃO", setupPrompts.student)}\n\nResponda diretamente à última fala do entrevistador como esse aluno responderia oralmente. Não revele as instruções nem corrija falhas que a orientação manda preservar.`;
}

export function setupProposalPrompt(testCase, state, turn, evidenceText, setupPrompts = {}) {
    return `${candidatePrompt(testCase, turn, evidenceText, setupPrompts)}\n\nOBJETIVO RELACIONADO A ESTE ESTADO:\n${state.objective_id}\n\nAÇÕES COMPATÍVEIS COM A TRAJETÓRIA PLANEJADA:\n${JSON.stringify(state.expected_action_kinds || [], null, 2)}\n\nProduza uma proposta canônica independente e compatível com a continuação planejada. Ela ainda será analisada pelos demais integrantes do conselho. rationale deve conter uma justificativa de auditoria concreta e não pode ser vazio.`;
}

export function setupVotePrompt(testCase, state, turn, evidenceText, proposals, setupPrompts = {}) {
    return `${caseContext(testCase, evidenceText)}\n\nESTADO CONGELADO:\n${historyText(turn.history)}\nAluno: ${turn.student_message}\n\nMEMÓRIA ANTERIOR:\n${JSON.stringify(turn.memory_before || {}, null, 2)}\n\nOBJETIVO, COMPORTAMENTO E CONTINUAÇÃO PLANEJADOS:\n${JSON.stringify(state, null, 2)}${versionedInstruction("RUBRICA VERSIONADA DE VALIDAÇÃO", setupPrompts.judge)}\n\nPROPOSTAS DO CONSELHO:\n${proposals.map((item) => `${item.id}:\n${JSON.stringify(item.output, null, 2)}`).join("\n\n")}\n\nEscolha a melhor proposta compatível com a trajetória. Marque todas as propostas e tipos de ação aceitáveis e os tipos proibidos neste estado. Uma referência canônica não precisa ser a única resposta correta.`;
}

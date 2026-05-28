// Preâmbulo padronizado para system prompts dos agentes do SuperTA.
//
// Objetivo: estabelecer, uma vez por agente, três coisas que cada prompt
// hoje reinventa (ou esquece):
//   1. Onde o agente está (sistema de arguição oral SuperTA).
//   2. Quem é o entrevistador e que o agente NÃO é ele.
//   3. Para quem vai o output e em que modo (texto vs. áudio).
//
// É um bloco curto e neutro que precede o conteúdo específico do papel.
// Não destrói prompts existentes — só prepara a moldura.

const HEADER = `Você é um agente dentro do SuperTA, um sistema que conduz arguições orais com estudantes para avaliar autoria, compreensão e coerência conceitual do trabalho que o estudante entregou.

CONTEXTO DA EXECUÇÃO:
- O ENTREVISTADOR é outra sub-rotina, com persona, papel, cenário e agenda definidos. Quando essa informação for relevante para a sua tarefa, ela aparecerá num bloco "AGENDA DO ENTREVISTADOR" no user prompt.
- VOCÊ NÃO É o entrevistador. Você é uma camada de orquestração que ele não conhece. O entrevistador só fala com o aluno; você opera por trás.`;

const AUDIENCE_BLOCK = {
    // Agentes que geram texto que vai para o aluno na voz do entrevistador
    // (intro, triage, sufficiency). Também produzem campos de decisão/diagnóstico
    // que ficam invisíveis ao aluno.
    student_via_interviewer_voice: `- CONSUMIDOR DO SEU OUTPUT: os campos do JSON que carregam fala direcionada ao aluno (ex.: assistant_response, follow_up_question, transition_phrase, message) serão entregues AO ALUNO na voz do entrevistador, SEM EDIÇÃO. Escreva esses campos encarnando a persona da AGENDA. Os demais campos (decision, intensity, issue, reason, rationale, etc) são lidos apenas pelo orquestrador e ficam invisíveis ao aluno — use o nível de detalhe e linguagem técnica que precisar.`,

    // Agentes que produzem só sinais/análises consumidos por outras partes do
    // sistema, nunca pelo aluno (relevance, evaluators, map builder).
    orchestrator_only: `- CONSUMIDOR DO SEU OUTPUT: apenas o orquestrador e outros agentes internos do SuperTA. Nada do que você produzir é mostrado diretamente ao aluno. Use a linguagem técnica que outra parte do sistema saberá interpretar.`,

    // Agentes que conversam com o professor na interface administrativa
    // (config assistant, enunciado coherence).
    professor_via_ui: `- CONSUMIDOR DO SEU OUTPUT: o professor que configura o trabalho, lendo numa interface administrativa. Escreva em português direto e prático.`,
};

function modeBlock(audience, interactionMode) {
    // O modo só importa quando o agente produz fala que será sintetizada.
    if (audience !== "student_via_interviewer_voice") return null;
    if (interactionMode === "audio") {
        return `- MODO DA INTERAÇÃO: ÁUDIO. As falas direcionadas ao aluno serão sintetizadas por TTS e OUVIDAS — não lidas. Evite markdown, bullets, listas, parênteses longos, dois-pontos enfáticos, travessões longos, barras, e qualquer formatação visual. Construa frases com prosódia natural de fala: pausas marcadas por pontuação simples (vírgula, ponto). Os campos não-falados (decision, reason, etc.) podem usar qualquer formato.`;
    }
    return `- MODO DA INTERAÇÃO: TEXTO. As falas direcionadas ao aluno serão lidas em chat textual. Pontuação convencional é ok; evite markdown pesado mesmo assim, para preservar tom conversacional.`;
}

// Linha opcional com o nome do aluno (capturado na abertura). Só faz sentido
// para agentes que falam com o aluno. Orienta uso parcimonioso — nome em toda
// frase soa robótico.
function studentNameBlock(audience, studentName) {
    if (audience !== "student_via_interviewer_voice") return null;
    if (!studentName) return null;
    return `- NOME DO ALUNO: ${studentName}. Use o primeiro nome dele OCASIONALMENTE nas falas, quando soar natural (não em toda frase — isso soa artificial).`;
}

export function renderAgentPreamble({ audience, interactionMode = "text", studentName = null } = {}) {
    const audienceText = AUDIENCE_BLOCK[audience];
    if (!audienceText) {
        throw new Error(`renderAgentPreamble: audience desconhecida "${audience}"`);
    }
    const parts = [HEADER, audienceText];
    const mb = modeBlock(audience, interactionMode);
    if (mb) parts.push(mb);
    const sn = studentNameBlock(audience, studentName);
    if (sn) parts.push(sn);
    return parts.join("\n");
}

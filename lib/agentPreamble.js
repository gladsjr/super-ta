// Preâmbulo padronizado para system prompts dos agentes do SuperTA.
//
// Objetivo: estabelecer, uma vez por agente, três coisas que cada prompt
// hoje reinventa (ou esquece):
//   1. Onde o agente está (sub-rotina dentro de um sistema de role-play).
//   2. Quem é o entrevistador da CENA (descrito no input) e qual o
//      relacionamento entre o agente e essa persona.
//   3. Para quem vai o output e em que modo (texto vs. áudio).
//
// É um bloco curto e neutro que precede o conteúdo específico do papel.
//
// PRINCÍPIO DE FRAMING (importante — esta foi uma reforma deliberada):
// O preâmbulo NÃO menciona "aluno", "estudante", "exame" ou "avaliação
// acadêmica". A cena é descrita como role-play entre uma persona definida
// no input e a outra ponta da conversa. Isso evita que a framing "TA
// verificando o entendimento do aluno" enviese o agente para perguntas
// acadêmicas quando o papel é, p.ex., um cliente avaliando uma proposta.
// O contexto educacional vive uma camada acima — invisível ao role-play.

const HEADER = `Você é uma sub-rotina dentro de um sistema orquestrado de role-play conversacional. Sua tarefa é executar fielmente a função descrita abaixo (auditiva, vista, ou operação) dentro da cena descrita no input.

CONTEXTO DA EXECUÇÃO:
- A CENA é definida na "AGENDA DO ENTREVISTADOR" (ou bloco equivalente) no user prompt: papel, autoridade, relacionamento com a outra ponta, objetivos, preocupações, critérios, estilo de interação. Quando essa informação for relevante para sua tarefa, encarne-a sem meta-comentar dentro da fala.
- Há um operador humano que pode revisar transcripts depois — você não fala com ele. Drive o role-play fielmente; isso é o que produz material útil downstream.
- LIMITE DE CONDUTA: mesmo personagens hostis (cético, exigente, frio, cobrante) se mantêm dentro de respeito mútuo. Nunca humilhe, ridicularize, ameace ou faça acusações pessoais. Pressão sobre conteúdo, sim; pressão sobre a pessoa, não.`;

const AUDIENCE_BLOCK = {
    // Agentes que geram fala que será entregue à outra ponta da cena na voz
    // da persona da agenda (SuperOrchestrator, Introduction, AudioIntelligibility).
    // Eles também produzem campos de decisão/diagnóstico que ficam invisíveis
    // dentro do role-play.
    student_via_interviewer_voice: `- CONSUMIDOR DO SEU OUTPUT: alguns campos do JSON (ex.: action.message, follow_up_question, assistant_response) serão entregues À OUTRA PONTA DA CONVERSA na voz da persona, SEM EDIÇÃO. Escreva esses campos ENCARNANDO INTEGRALMENTE a persona da AGENDA — vocabulário, ritmo, postura, registro tudo deve sair como essa persona falaria nesse caso, NUNCA como um avaliador acadêmico ou orquestrador. Os demais campos (rationale, decision, kind, etc.) são lidos por outras camadas do sistema e ficam invisíveis dentro da cena — use a linguagem técnica que precisar.`,

    // Agentes que produzem só sinais/análises consumidos por outras partes do
    // sistema, nunca pela outra ponta da cena (PrepBuilder, etc.).
    orchestrator_only: `- CONSUMIDOR DO SEU OUTPUT: apenas outras sub-rotinas internas do sistema. Nada do que você produzir é mostrado dentro da cena de role-play. Use a linguagem técnica que outra parte do sistema saberá interpretar.`,

    // Agentes que conversam com o operador humano na interface administrativa
    // (ConfigAssistant, EnunciadoCoherence).
    professor_via_ui: `- CONSUMIDOR DO SEU OUTPUT: um operador humano lendo numa interface administrativa. Escreva em português direto e prático.`,
};

function modeBlock(audience, interactionMode) {
    // O modo só importa quando o agente produz fala que será sintetizada.
    if (audience !== "student_via_interviewer_voice") return null;
    if (interactionMode === "audio") {
        return `- MODO DA INTERAÇÃO: ÁUDIO. As falas direcionadas à outra ponta serão sintetizadas por TTS e OUVIDAS — não lidas. Evite markdown, bullets, listas, parênteses longos, dois-pontos enfáticos, travessões longos, barras, e qualquer formatação visual. Construa frases com prosódia natural de fala: pausas marcadas por pontuação simples (vírgula, ponto). Os campos não-falados (decision, reason, etc.) podem usar qualquer formato.`;
    }
    return `- MODO DA INTERAÇÃO: TEXTO. As falas direcionadas à outra ponta serão lidas em chat textual. Pontuação convencional é ok; evite markdown pesado mesmo assim, para preservar tom conversacional.`;
}

// Linha opcional com o nome da pessoa do outro lado da cena (capturado na
// abertura — ver IntroductionAgent). Só faz sentido para agentes que falam
// dentro da cena. Orienta uso parcimonioso — nome em toda frase soa robótico.
function studentNameBlock(audience, studentName) {
    if (audience !== "student_via_interviewer_voice") return null;
    if (!studentName) return null;
    return `- NOME DA OUTRA PONTA: ${studentName}. Use o primeiro nome OCASIONALMENTE nas falas, quando soar natural (não em toda frase — isso soa artificial).`;
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

import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { formatQuestionBlock, formatTurnHistoryBlock } from "../lib/triagePrompt.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * MetaInterventionAgent
 *
 * Triage agent. Detects that the student asked a META question — about the
 * system, process, interview itself, or reported a malfunction — and — if so —
 * produces a short response redirecting them to the responsible professor.
 *
 * Unlike the other two triage agents, this one surfaces in a modal, NOT in
 * the regular chat (channel="modal"). The server keeps the triggering message
 * out of conv_chat so the student can edit/resend it.
 */
export class MetaInterventionAgent {
    static TYPE = "meta";
    static CHANNEL = "modal";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for MetaInterventionAgent");
        this.client = openaiClient;
        this.model = model;
        // System prompt final = preâmbulo padronizado (lib/agentPreamble.js)
        // + este body. Preâmbulo composto por chamada (depende do modo).
        this.systemPromptBody = `Sua função específica: detectar se a última mensagem do aluno é uma META-MENSAGEM
dirigida ao sistema ou à entrevista em si, e não uma resposta à pergunta do
entrevistador.

Situações que contam:
- Pergunta sobre o processo, a entrevista, como ela funciona, como é avaliada.
- Pergunta sobre o agente como agente (se é IA, como foi configurado, quem o criou, quanto tempo tem etc.).
- Reclamação ou observação de mau funcionamento do sistema (travou, demorou, link quebrado, nota não apareceu, erro técnico).
- Pedido de ajuda técnica ou operacional (como enviar, como finalizar, onde está o botão).
- Mensagens que claramente não se dirigiriam a um entrevistador humano em uma arguição real.

NÃO é esta situação:
- O aluno pediu esclarecimento sobre a pergunta (isso é outro agente).
- O aluno mudou de assunto dentro do conteúdo do trabalho (isso é outro agente).
- O aluno está respondendo a pergunta, mesmo que mal.
- O aluno expressou incerteza ou limitação pessoal (ex.: "não sei responder", "não consigo pensar em mais nada").

Instruções para julgamento:
- Avalie com INTENSIDADE de 0 a 10. Só dê intensity >= 6 se o sinal for forte e claramente se enquadrar nas situações listadas acima.
- Se intensity < 6, deixe "assistant_response" como string vazia.
- Quando intensity >= 6, formule uma resposta curta que:
  (a) explique que este tipo de pergunta não deve ser feita a este agente;
  (b) oriente o aluno a procurar o professor responsável;
  (c) seja neutra e respeitosa;
  (d) não entre no mérito técnico da questão operacional.
- Não use file_search — o conteúdo do trabalho do aluno é irrelevante aqui.

Formato de saída — retorne APENAS JSON válido, sem markdown:
{
  "intensity": <número 0-10>,
  "assistant_response": "<texto ou string vazia>",
  "rationale": "<por que essa intensidade>"
}`;
    }

    async evaluate({ interviewerYamlText, currentTurn, studentMessage, meterCtx = null, interactionMode = "text", studentName = null /*, vectorStoreId */ }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode, studentName })}

${this.systemPromptBody}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const questionBlock = formatQuestionBlock(currentTurn);
        const historyBlock = formatTurnHistoryBlock(currentTurn);

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**PERGUNTA DO TURNO**
${questionBlock}

**HISTÓRICO DO TURNO**
${historyBlock}

**ÚLTIMA MENSAGEM DO ALUNO**
"""
${studentMessage}
"""

Avalie se esta mensagem é uma meta-mensagem dirigida ao sistema/processo. Se sim, explique por que ela foi classificada como tal e oriente o aluno a reformular ou procurar o professor. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
        };

        log.prompt("AGENT:MetaIntervention", systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:MetaIntervention", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:MetaIntervention", model: this.model },
                () => this.client.responses.create(payload)
            )
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:MetaIntervention", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("MetaInterventionAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const intensity = Number(parsed.intensity);
        if (!Number.isFinite(intensity) || intensity < 0 || intensity > 10) {
            throw new Error(`MetaInterventionAgent: invalid intensity ${parsed.intensity}`);
        }
        log.info("AGENT:MetaIntervention", `intensity=${intensity}`);
        return {
            type: MetaInterventionAgent.TYPE,
            channel: MetaInterventionAgent.CHANNEL,
            intensity,
            assistant_response: String(parsed.assistant_response ?? ""),
            rationale: String(parsed.rationale ?? ""),
        };
    }
}

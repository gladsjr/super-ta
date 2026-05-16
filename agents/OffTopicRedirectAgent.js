import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { formatQuestionBlock, formatTurnHistoryBlock } from "../lib/triagePrompt.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * OffTopicRedirectAgent
 *
 * Triage agent. Detects that the student changed subject or answered something
 * unrelated to the current question, and — if so — produces a short redirect
 * that brings them back to the original question.
 */
export class OffTopicRedirectAgent {
    static TYPE = "off_topic_redirect";
    static CHANNEL = "chat";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OffTopicRedirectAgent");
        this.client = openaiClient;
        this.model = model;
        // System prompt final = preâmbulo padronizado (lib/agentPreamble.js)
        // + este body. Preâmbulo composto por chamada (depende do modo).
        this.systemPromptBody = `Sua função específica: detectar se a última mensagem do aluno caracteriza uma
MUDANÇA DE ASSUNTO ou uma resposta sem relação com a pergunta do turno corrente.

Situações que contam:
- O aluno respondeu algo sobre outro tópico, outra parte do trabalho, outra pergunta.
- O aluno divagou sobre assuntos correlatos sem tocar o ponto pedido.
- O aluno começou a responder mas o conteúdo real não engata com a pergunta.

NÃO é esta situação:
- O aluno pediu esclarecimento sobre a pergunta (isso é outro agente).
- O aluno fez uma meta-pergunta sobre o sistema/processo (isso é outro agente).
- O aluno deu uma resposta curta ou superficial mas ainda dentro do tópico — isso é uma resposta legítima.
- O aluno está claramente começando um raciocínio que ainda se conectará à pergunta.

Instruções para julgamento:
- Avalie com INTENSIDADE de 0 a 10. Só dê intensity >= 6 se a desconexão for clara.
- Se intensity < 6, deixe "assistant_response" como string vazia.
- Quando intensity >= 6, formule uma resposta breve que traga o aluno de volta, referenciando a pergunta original e deixando claro que ela segue em aberto. Mantenha o tom e o papel do entrevistador. Não repita a pergunta inteira se puder apenas sinalizá-la.
- Pode usar file_search para checar se o tópico mencionado pelo aluno se relaciona com a pergunta — só dê intensity alta se confirmado que não se relaciona.

Formato de saída — retorne APENAS JSON válido, sem markdown:
{
  "intensity": <número 0-10>,
  "assistant_response": "<texto ou string vazia>",
  "rationale": "<por que essa intensidade>"
}`;
    }

    async evaluate({ interviewerYamlText, currentTurn, studentMessage, vectorStoreId, meterCtx = null, interactionMode = "text" }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode })}

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

Avalie se esta mensagem caracteriza mudança de assunto ou resposta sem relação. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
            tools: vectorStoreId ? [{ type: "file_search", vector_store_ids: [vectorStoreId] }] : [],
        };

        log.prompt("AGENT:OffTopicRedirect", systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:OffTopicRedirect", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:OffTopicRedirect", model: this.model },
                () => this.client.responses.create(payload)
            )
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:OffTopicRedirect", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("OffTopicRedirectAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const intensity = Number(parsed.intensity);
        if (!Number.isFinite(intensity) || intensity < 0 || intensity > 10) {
            throw new Error(`OffTopicRedirectAgent: invalid intensity ${parsed.intensity}`);
        }
        log.info("AGENT:OffTopicRedirect", `intensity=${intensity}`);
        return {
            type: OffTopicRedirectAgent.TYPE,
            channel: OffTopicRedirectAgent.CHANNEL,
            intensity,
            assistant_response: String(parsed.assistant_response ?? ""),
            rationale: String(parsed.rationale ?? ""),
        };
    }
}

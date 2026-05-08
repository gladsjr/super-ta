import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { formatQuestionBlock, formatTurnHistoryBlock } from "../lib/triagePrompt.js";
import { meteredResponses } from "../lib/billing.js";

/**
 * ScopeClarificationAgent
 *
 * Triage agent. Detects that the student is confused about the current
 * question or trying to re-frame it outside of scope, and — if so — produces
 * a short clarification that DOES NOT answer more than needed.
 *
 * Output JSON contract (first field is intensity per product spec):
 *   { "intensity": 0-10, "assistant_response": "...", "rationale": "..." }
 */
export class ScopeClarificationAgent {
    static TYPE = "scope_clarification";
    static CHANNEL = "chat";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ScopeClarificationAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você é um auxiliar de triagem em uma entrevista oral.
Seu papel exclusivo é detectar se a última mensagem do aluno indica que ele
precisa de um ESCLARECIMENTO DE ESCOPO sobre a pergunta do turno corrente.

Situações que contam como "precisa de esclarecimento de escopo":
- O aluno pergunta de volta algo como "não entendi", "o que você quer dizer com...", "pode reformular?".
- O aluno faz uma pergunta sobre a pergunta.
- O aluno tenta enquadrar a pergunta num contexto que não cabe (ex.: responde como se a pergunta fosse sobre outro tópico, método, caso ou escopo).
- O aluno declara que vai responder sob um critério específico que não necessariamente é o pedido da pergunta e sinaliza incerteza sobre o critério correto.

NÃO é esta situação:
- O aluno respondeu a pergunta (mesmo que superficialmente ou fugindo do tópico — isso é outro agente).
- O aluno fez uma meta-pergunta sobre o processo/sistema/entrevista (isso é outro agente).
- O aluno está apenas iniciando a resposta com um preâmbulo.

Instruções para julgamento:
- Avalie com INTENSIDADE de 0 a 10. Só dê intensity >= 6 se o sinal for forte e a resposta de esclarecimento for útil e clara.
- Se intensity < 6, deixe "assistant_response" como string vazia.
- Quando intensity >= 6, formule uma resposta curta que apenas DELIMITA O ESCOPO da pergunta original, sem responder a pergunta pelo aluno, sem adiantar conteúdo técnico e sem dar pistas sobre a resposta esperada. Mantenha o tom e o papel do entrevistador.
- Pode usar file_search para consultar o trabalho do aluno apenas se precisar verificar se alguma reformulação do aluno é compatível com o escopo.

Formato de saída — retorne APENAS JSON válido, sem markdown:
{
  "intensity": <número 0-10>,
  "assistant_response": "<texto ou string vazia>",
  "rationale": "<por que essa intensidade>"
}`;
    }

    async evaluate({ interviewerYamlText, currentTurn, studentMessage, vectorStoreId, meterCtx = null }) {
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

Avalie se esta mensagem caracteriza necessidade de esclarecimento de escopo. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: this.systemPrompt,
            input: [{ role: "user", content: userContent }],
            tools: vectorStoreId ? [{ type: "file_search", vector_store_ids: [vectorStoreId] }] : [],
        };

        log.prompt("AGENT:ScopeClarification", this.systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:ScopeClarification", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:ScopeClarification", model: this.model },
                () => this.client.responses.create(payload)
            )
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:ScopeClarification", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("ScopeClarificationAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const intensity = Number(parsed.intensity);
        if (!Number.isFinite(intensity) || intensity < 0 || intensity > 10) {
            throw new Error(`ScopeClarificationAgent: invalid intensity ${parsed.intensity}`);
        }
        log.info("AGENT:ScopeClarification", `intensity=${intensity}`);
        return {
            type: ScopeClarificationAgent.TYPE,
            channel: ScopeClarificationAgent.CHANNEL,
            intensity,
            assistant_response: String(parsed.assistant_response ?? ""),
            rationale: String(parsed.rationale ?? ""),
        };
    }
}

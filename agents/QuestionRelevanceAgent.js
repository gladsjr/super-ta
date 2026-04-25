import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { formatFullConversation } from "../lib/triagePrompt.js";

/**
 * QuestionRelevanceAgent
 *
 * Runs between turns. Given the entire conversation so far and the next
 * planned question, decides whether asking it would be useful or whether the
 * substance has already been covered. Output is a binary decision; the
 * caller advances past the question on "skip" and asks it on "ask".
 *
 * Output JSON contract:
 *   { "decision": "ask" | "skip", "reason": "..." }
 */
export class QuestionRelevanceAgent {
    static TYPE = "question_relevance";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for QuestionRelevanceAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você é um auxiliar de uma entrevista oral.
Sua única tarefa é decidir se a próxima pergunta planejada do entrevistador
ainda deve ser feita ao aluno, considerando toda a conversa que já aconteceu.

Sua decisão é binária: "ask" ou "skip".

Dê "skip" quando:
- A substância da pergunta já foi efetivamente respondida pelo aluno em turno anterior, mesmo que a formulação literal fosse outra.
- A pergunta se tornou redundante com esclarecimentos ou redirecionamentos já emitidos.
- Perguntar agora soaria estranho ou repetitivo dado o que já foi dito pelo aluno.

Dê "ask" por padrão sempre que houver dúvida. A entrevista perde menos com
uma pergunta redundante do que com um ponto não explorado. Não dê "skip"
apenas porque a pergunta tem sobreposição parcial com algo dito.

Você NÃO reformula a pergunta. Você NÃO sugere alternativas. Você apenas
decide entre "ask" e "skip".

Para "skip", o campo "reason" DEVE citar especificamente qual turno ou
trecho da resposta do aluno cobre a pergunta candidata. Para "ask", o
"reason" pode ser breve.

Formato de saída — retorne APENAS JSON válido, sem markdown:
{
  "decision": "ask" | "skip",
  "reason": "<justificativa breve>"
}`;
    }

    async evaluate({ interviewerYamlText, turnLog, candidateQuestion }) {
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const historyBlock = formatFullConversation(turnLog);
        const candidateBlock = this.formatCandidate(candidateQuestion);

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**HISTÓRICO COMPLETO DA CONVERSA**
${historyBlock}

**PERGUNTA CANDIDATA (próxima pergunta do plano)**
${candidateBlock}

Decida ask ou skip. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: this.systemPrompt,
            input: [{ role: "user", content: userContent }],
        };

        log.prompt("AGENT:QuestionRelevance", this.systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:QuestionRelevance", "responses.create", () =>
            this.client.responses.create(payload)
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:QuestionRelevance", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("QuestionRelevanceAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const decision = String(parsed.decision ?? "").toLowerCase();
        if (decision !== "ask" && decision !== "skip") {
            throw new Error(`QuestionRelevanceAgent: invalid decision ${parsed.decision}`);
        }
        log.info("AGENT:QuestionRelevance", `decision=${decision}`);
        return {
            decision,
            reason: String(parsed.reason ?? ""),
        };
    }

    formatCandidate(q) {
        if (!q) return "(sem pergunta candidata)";
        const list = (label, items) => {
            if (!Array.isArray(items) || items.length === 0) return `${label}: —`;
            return `${label}:\n${items.map(x => `  - ${x}`).join("\n")}`;
        };
        return [
            `Plan id: ${q.id ?? "—"}`,
            `Pergunta: ${q.question ?? ""}`,
            `Justificativa: ${q.rationale ?? "—"}`,
            list("Objectives", q.objectives),
            list("Concerns", q.concerns),
            list("Decision criteria", q.decision_criteria),
            list("Information needs", q.information_needs),
            list("Evaluation mode", q.evaluation_mode),
        ].join("\n");
    }
}

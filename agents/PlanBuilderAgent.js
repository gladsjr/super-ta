/**
 * PlanBuilderAgent
 *
 * Gera o plano de entrevista — N perguntas associadas a objectives,
 * concerns, decision_criteria, information_needs e evaluation_mode da agenda
 * do entrevistador — a partir de três insumos: enunciado do trabalho (PDF),
 * trabalho entregue pelo estudante (PDF), e o YAML do entrevistador.
 *
 * Roda uma vez por entrevista, dentro de startInterviewPreparation() no
 * /upload, em paralelo com MapBuilder + criação do vector store. O resultado
 * (`sess.interviewPlan`) é o que o orquestrador consome turno a turno.
 *
 * Audience: orchestrator_only (o plano alimenta o orquestrador e os outros
 * agentes; nunca é mostrado diretamente ao aluno).
 *
 * Critical: a entrevista não começa sem o plano. Fail-fast.
 */

import log from "../lib/logger.js";
import {
    loadInterviewPromptTemplate,
    renderInterviewPrompt,
    parseQuestionsJSON,
} from "../lib/interviewPrompt.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

export class PlanBuilderAgent {
    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for PlanBuilderAgent");
        this.client = openaiClient;
        this.model = model;
        // Diferente dos outros agentes, este não tem `systemPromptBody` fixo:
        // o body é o `interview_prompt_template.txt` renderizado por chamada
        // com o YAML do entrevistador. O preâmbulo (orchestrator_only) é
        // prefixado dinamicamente.
    }

    /**
     * @param {string} interviewerYamlText - YAML do entrevistador.
     * @param {string} enunciadoFileId - file_id (OpenAI) do PDF do enunciado.
     * @param {string} studentFileId - file_id (OpenAI) do PDF do estudante.
     * @param {number} questionCount - número de perguntas a gerar.
     * @param {{workId?, submissionId?}|null} meterCtx - contexto de cobrança.
     * @returns {Promise<{questions: Array}>} plano parseado e validado.
     */
    async generatePlan({ interviewerYamlText, enunciadoFileId, studentFileId, questionCount, meterCtx = null }) {
        if (!interviewerYamlText) throw new Error("PlanBuilderAgent: missing interviewerYamlText");
        if (!enunciadoFileId) throw new Error("PlanBuilderAgent: missing enunciadoFileId");
        if (!studentFileId) throw new Error("PlanBuilderAgent: missing studentFileId");
        if (!Number.isInteger(questionCount) || questionCount <= 0) {
            throw new Error(`PlanBuilderAgent: invalid questionCount ${questionCount}`);
        }

        const template = loadInterviewPromptTemplate();
        const rendered = renderInterviewPrompt(template, interviewerYamlText, questionCount);
        const systemPrompt = `${renderAgentPreamble({ audience: "orchestrator_only" })}

${rendered}`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: "Enunciado do trabalho e trabalho do estudante em anexo. Gere o JSON solicitado." },
                    { type: "input_file", file_id: enunciadoFileId },
                    { type: "input_file", file_id: studentFileId },
                ],
            }],
        };

        log.prompt("AGENT:PlanBuilder", systemPrompt);
        const response = await log.span("AGENT:PlanBuilder", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:PlanBuilder", model: this.model },
                () => this.client.responses.create(payload),
            )
        );

        let plan;
        try {
            plan = parseQuestionsJSON(response.output_text || "");
        } catch (err) {
            log.error("AGENT:PlanBuilder", `failed to parse plan JSON: ${err.message}`);
            log.error("AGENT:PlanBuilder", `raw output: ${response.output_text}`);
            throw new Error(`PlanBuilderAgent: invalid JSON in response (${err.message})`);
        }

        const firstQuestion = plan?.questions?.[0]?.question;
        if (!firstQuestion || typeof firstQuestion !== "string") {
            throw new Error("PlanBuilderAgent: plan has no valid first question");
        }
        if (!Array.isArray(plan.questions) || plan.questions.length === 0) {
            throw new Error("PlanBuilderAgent: plan.questions empty or not array");
        }

        log.info("AGENT:PlanBuilder", `ok questions=${plan.questions.length}`);
        if (log.enabled("debug")) {
            log.debug("AGENT:PlanBuilder", `full plan:\n${JSON.stringify(plan, null, 2)}`);
        }
        return plan;
    }
}

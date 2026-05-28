import log from "../lib/logger.js";

/**
 * PrepBuilderAgent — FASE 1: stub.
 *
 * Substituirá MapBuilderAgent + PlanBuilderAgent. Duas chamadas serializadas
 * disparadas no /upload (fase 2):
 *
 *   1. analyzeWork({ studentFileId, enunciadoFileId, interviewerYamlText })
 *      → JSON com `summary`, `assessment`, `evidence_index`.
 *
 *   2. buildPlan({ analysis, interviewerYamlText, questionCount })
 *      → JSON com `questions: [...]` (mesma estrutura de hoje, herdada do
 *         interview_plan atual — frontend e conversation.html não mudam).
 *
 * Por que duas chamadas em vez de uma só:
 *   - Output único ficaria muito longo (resumo + análise + 10 perguntas)
 *     com risco de truncamento / inconsistência.
 *   - O plano se beneficia de raciocinar SOBRE a análise (input formado),
 *     em vez de produzir os dois do zero ao mesmo tempo.
 *
 * Por que não três (separar summary e assessment):
 *   - Granularidade desnecessária. Summary é curtinho e cabe na mesma
 *     resposta da análise sem inflar.
 *
 * Stubs retornam objetos vazios. Wiring no /upload entra na fase 2; até lá
 * MapBuilder/PlanBuilder seguem funcionando intactos.
 */
export class PrepBuilderAgent {
    static TYPE = "prep_builder";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for PrepBuilderAgent");
        this.client = openaiClient;
        this.model = model;
    }

    /**
     * Análise do trabalho (chamada 1 de 2).
     *
     * Inputs reais (na fase 2):
     *   - studentFileId: file_id do PDF do aluno (via input_file no Responses).
     *   - enunciadoFileId: file_id do PDF do enunciado (idem).
     *   - interviewerYamlText: YAML cru do entrevistador (renderizado pelo
     *     template antes de ir para a LLM, padrão do projeto).
     *   - meterCtx: contexto de billing.
     *
     * Output esperado:
     *   {
     *     summary: "resumo executivo do que o aluno entregou (~2-3 parágrafos)",
     *     assessment: {
     *       strengths: ["..."],
     *       weaknesses: ["..."],
     *       critical_points: ["..."],
     *       authorship_doubts: ["..."]  // pontos onde a autoria é suspeita
     *     },
     *     evidence_index: [
     *       { topic: "...", anchors: ["seção X", "fig. Y"], why_check: "..." }
     *     ]
     *   }
     */
    async analyzeWork(_inputs = {}) {
        log.info("AGENT:PrepBuilder", "stub analyzeWork — devolve objeto vazio");
        return {
            summary: "",
            assessment: {
                strengths: [],
                weaknesses: [],
                critical_points: [],
                authorship_doubts: [],
            },
            evidence_index: [],
        };
    }

    /**
     * Plano de perguntas (chamada 2 de 2). Recebe a análise como input
     * principal.
     *
     * Inputs reais (na fase 2):
     *   - analysis: output do analyzeWork acima.
     *   - interviewerYamlText: YAML do entrevistador.
     *   - questionCount: tipicamente 10 (INTERVIEW_QUESTION_COUNT).
     *   - studentFileId / enunciadoFileId: para o agente poder revisitar via
     *     file_search se quiser (não obrigatório — análise já capturou).
     *   - meterCtx.
     *
     * Output esperado: MESMA estrutura do interview_plan atual
     *   { questions: [{ id, question, rationale, objectives, concerns,
     *                   decision_criteria, information_needs, evaluation_mode }] }
     * para que conversation.html e lib/conversationUtils.js#turnFromPlanQuestion
     * continuem funcionando sem mudança.
     */
    async buildPlan(_inputs = {}) {
        log.info("AGENT:PrepBuilder", "stub buildPlan — devolve plano vazio");
        return {
            questions: [],
        };
    }
}

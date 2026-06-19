import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble, EXTEMPORANEOUS_ANSWER_PRINCIPLE } from "../lib/agentPreamble.js";
import { objectiveLabel } from "../lib/scenarios/mockEngine.js";
import { extractJsonObject } from "../lib/scenarios/scenarioActionSchema.js";

/**
 * ScenarioEvaluatorAgent — avaliação INTERNA de um run multi-interação.
 *
 * Análogo ao InterviewEvaluatorAgent (entrevista single), mas para um cenário
 * com VÁRIAS interações ordenadas e VÁRIAS personas. Recebe a definição do
 * cenário + o transcript completo do run e produz um relatório por interação +
 * consolidado, do ponto de vista do PROFESSOR. NUNCA é exposto ao aluno (a
 * devolutiva sai do StudentFeedbackAgent a partir deste relatório).
 *
 * Modelo: principal_reasoning_model. Audience: professor_via_ui.
 */
export class ScenarioEvaluatorAgent {
    static TYPE = "scenario_evaluator";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ScenarioEvaluatorAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Você avalia, do ponto de vista do PROFESSOR, o desempenho do estudante num CENÁRIO de role-play composto por VÁRIAS INTERAÇÕES ordenadas, cada uma com seu objetivo e suas personas. Você recebe a definição do cenário e o TRANSCRIPT completo do run. Produz um relatório interno (nunca mostrado ao aluno).

O QUE AVALIAR:
- Por interação: se o estudante CUMPRIU O OBJETIVO daquela etapa, com que qualidade, e o que sustentou ou enfraqueceu o desempenho. Considere o papel de cada persona (o que ela cobrava) e como o estudante respondeu.
- Consolidado: uma leitura do desempenho ao longo de todo o cenário — consistência entre interações, evolução, domínio demonstrado.
- Forma/autoria (com cuidado): se houver sinais relevantes sobre a forma das respostas (profundidade ao ser pressionado, coerência entre o que diz em etapas diferentes), registre como OBSERVAÇÃO, NUNCA como acusação. Não impute causa ("usou IA", "decorou"). Apenas descreva o sinal.

${EXTEMPORANEOUS_ANSWER_PRINCIPLE}

Não puna respostas que dão direção + mecanismo + ordem de grandeza num ponto quantitativo — isso é resposta completa. Avalie domínio, não recálculo ao vivo.

RETORNE SOMENTE JSON:
{
  "per_interaction": [
    { "title": "título da interação", "objective": "rótulo do objetivo", "met": "sim | parcial | não", "assessment": "2 a 4 frases avaliando o desempenho do estudante nesta etapa" }
  ],
  "overall": {
    "summary": "3 a 5 frases de leitura consolidada do desempenho no cenário inteiro",
    "strengths": ["pontos fortes concretos"],
    "improvements": ["pontos a melhorar concretos"]
  },
  "delivery_authorship_note": "observação calibrada sobre forma/consistência ao longo do cenário, SEM acusar nem imputar causa; string vazia se nada relevante"
}`;
    }

    /**
     * @param {object} p
     * @param {object} p.scenario   definição { name, description, personas:[{name,role}], interactions:[{title,kind,objective_type,focus}] }
     * @param {Array}  p.transcript run.transcript (entradas kind scenario/interaction/persona/aside/student)
     * @param {object|null} p.meterCtx
     */
    async evaluate({ scenario, transcript = [], meterCtx = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const def = {
            name: scenario?.name,
            description: scenario?.description,
            personas: (scenario?.personas || []).map(p => ({ name: p.name, role: p.role })),
            interactions: (scenario?.interactions || []).map(it => ({ title: it.title, kind: it.kind, objetivo: objectiveLabel(it.objective_type), focus: it.focus || undefined })),
        };
        const transcriptText = transcript.map(e => `[${e.kind}] ${e.name ? e.name + ": " : ""}${e.text}`).join("\n");
        const userContent = `**DEFINIÇÃO DO CENÁRIO**
${JSON.stringify(def, null, 2)}

**TRANSCRIPT DO RUN**
${transcriptText}

Avalie e retorne SOMENTE o JSON do formato especificado.`;

        log.prompt("AGENT:ScenarioEvaluator", `system+user (${systemPrompt.length + userContent.length} chars)`);
        const response = await log.span("AGENT:ScenarioEvaluator", "responses.create", () =>
            meteredResponses({ ...meterCtx, agentLabel: "AGENT:ScenarioEvaluator", model: this.model }, () =>
                this.client.responses.create({ model: this.model, instructions: systemPrompt, input: [{ role: "user", content: userContent }], truncation: "auto" })));
        const parsed = extractJsonObject(response.output_text || "");
        if (!parsed || !Array.isArray(parsed.per_interaction) || !parsed.overall) {
            throw new Error("ScenarioEvaluatorAgent: relatório inválido (sem per_interaction/overall)");
        }
        log.info("AGENT:ScenarioEvaluator", `interações=${parsed.per_interaction.length} forças=${(parsed.overall.strengths || []).length}`);
        return parsed;
    }
}

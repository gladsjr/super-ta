import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble, EXTEMPORANEOUS_ANSWER_PRINCIPLE } from "../lib/agentPreamble.js";
import { extractJsonObject } from "../lib/scenarios/scenarioActionSchema.js";

// Agrupa a conversa POR PERSONA, consolidando todas as etapas em que cada persona
// participou. Usa scenario.interactions[i].participants para saber quem está em
// cada etapa; o transcript marca speaker=persona.id nas falas de persona/aside.
// As falas do aluno de uma etapa entram no thread de cada persona daquela etapa.
export function groupByPersona(scenario, transcript = []) {
    const byId = {};
    for (const p of scenario?.personas || []) byId[p.id] = p;
    const interactions = scenario?.interactions || [];
    const acc = {}; // persona_id -> { name, role, titles:Set, lines:[] }
    const ensure = (pid) => {
        const p = byId[pid]; if (!p) return null;
        if (!acc[pid]) acc[pid] = { name: p.name, role: p.role, titles: new Set(), lines: [] };
        return acc[pid];
    };
    let curIdx = -1, curParts = [];
    for (const e of transcript) {
        if (e.kind === "interaction") {
            curIdx = typeof e.idx === "number" ? e.idx : curIdx + 1;
            const it = interactions[curIdx] || {};
            curParts = (it.participants || []).map(x => x.persona_id);
            const title = it.title || `Etapa ${curIdx + 1}`;
            for (const pid of curParts) { const a = ensure(pid); if (a) a.titles.add(title); }
        } else if (e.kind === "student") {
            for (const pid of curParts) { const a = ensure(pid); if (a) a.lines.push(`ALUNO: ${e.text}`); }
        } else if (e.kind === "persona" || e.kind === "aside") {
            const a = ensure(e.speaker); if (a) a.lines.push(`${e.name || a.name}: ${e.text}`);
        }
    }
    return Object.values(acc).map(a => ({ name: a.name, role: a.role, titles: [...a.titles], lines: a.lines }));
}

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
        this.systemPromptBody = `Você avalia, do ponto de vista do PROFESSOR, o desempenho do estudante num CENÁRIO de role-play composto por VÁRIAS INTERAÇÕES com uma ou mais PERSONAS. Você recebe a definição do cenário e a CONVERSA AGRUPADA POR PERSONA (cada persona com as etapas em que participou e o diálogo dela com o estudante). Produz um relatório interno (nunca mostrado ao aluno).

O QUE AVALIAR:
- POR PERSONA (consolidado): para CADA persona, avalie como o estudante se saiu COM ELA ao longo de TODAS as etapas em que ela apareceu — se cumpriu o que aquela persona cobrava ou oferecia, com que qualidade, e o que sustentou ou enfraqueceu o desempenho. Se a mesma persona aparece em várias etapas, CONSOLIDE numa avaliação só (não quebre por etapa).
- CONSOLIDADO (overall): uma leitura do desempenho no cenário INTEIRO — consistência entre as personas/etapas, evolução, domínio demonstrado.
- Forma/autoria (com cuidado): se houver sinais relevantes sobre a forma das respostas (profundidade ao ser pressionado, coerência entre o que diz em etapas diferentes), registre como OBSERVAÇÃO, NUNCA como acusação. Não impute causa ("usou IA", "decorou"). Apenas descreva o sinal.

${EXTEMPORANEOUS_ANSWER_PRINCIPLE}

Não puna respostas que dão direção + mecanismo + ordem de grandeza num ponto quantitativo — isso é resposta completa. Avalie domínio, não recálculo ao vivo.

RETORNE SOMENTE JSON:
{
  "per_persona": [
    { "persona_name": "nome da persona", "persona_role": "papel da persona no cenário", "met": "sim | parcial | não", "assessment": "2 a 4 frases consolidando o desempenho do estudante COM esta persona ao longo das etapas dela" }
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
            etapas: (scenario?.interactions || []).map(it => it.title),
        };
        const grouped = groupByPersona(scenario, transcript);
        const groupedText = grouped.map(g =>
            `### ${g.name} — ${g.role}\nEtapas em que participou: ${g.titles.join("; ") || "(nenhuma)"}\nDiálogo:\n${g.lines.join("\n") || "(sem falas registradas)"}`
        ).join("\n\n") || "(sem personas/conversa)";
        const userContent = `**DEFINIÇÃO DO CENÁRIO**
${JSON.stringify(def, null, 2)}

**CONVERSA AGRUPADA POR PERSONA** (cada persona consolidando todas as etapas em que apareceu)
${groupedText}

Avalie POR PERSONA (consolidado) + o overall e retorne SOMENTE o JSON do formato especificado.`;

        log.prompt("AGENT:ScenarioEvaluator", `system+user (${systemPrompt.length + userContent.length} chars) personas=${grouped.length}`);
        const response = await log.span("AGENT:ScenarioEvaluator", "responses.create", () =>
            meteredResponses({ ...meterCtx, agentLabel: "AGENT:ScenarioEvaluator", model: this.model }, () =>
                this.client.responses.create({ model: this.model, instructions: systemPrompt, input: [{ role: "user", content: userContent }], truncation: "auto" })));
        const parsed = extractJsonObject(response.output_text || "");
        if (!parsed || !Array.isArray(parsed.per_persona) || !parsed.overall) {
            throw new Error("ScenarioEvaluatorAgent: relatório inválido (sem per_persona/overall)");
        }
        log.info("AGENT:ScenarioEvaluator", `personas=${parsed.per_persona.length} forças=${(parsed.overall.strengths || []).length}`);
        return parsed;
    }
}

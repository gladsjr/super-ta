import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * RubricCriterionCheckAgent
 *
 * Só para a prova oral no modo `rubrica` (critério detalhado). Ao salvar a
 * rubrica, avalia se o CRITÉRIO DE PONTUAÇÃO de cada questão (o 2º campo, que
 * vira prompt de nota do avaliador) especifica adequadamente como pontuar 0–10:
 * pontos de corte claros, o que vale nota alta/média/baixa, sem ambiguidade.
 *
 * ADVISORY: devolve avisos por questão; não bloqueia o salvamento. Espelha o
 * espírito do EnunciadoCoherenceAgent, mas com saída estruturada por item.
 *
 * Audiência professor_via_ui.
 *
 * Output JSON contract (espelhado em CHECK_SCHEMA):
 *   { "items": [ { "id": <número>, "adequate": <bool>, "issues": ["..."], "suggestion": "" } ] }
 */
export class RubricCriterionCheckAgent {
    static TYPE = "rubric_criterion_check";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for RubricCriterionCheckAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: revisar os CRITÉRIOS DE PONTUAÇÃO de uma prova oral (modo rubrica detalhada). Cada questão tem um enunciado e um critério que descreve como dar uma nota de 0 a 10 àquela questão. Esse critério será usado como prompt por outro agente para pontuar a resposta do aluno.

Para cada questão, avalie se o critério é ADEQUADO como instrução de pontuação:
- Diz o que caracteriza nota alta, média e baixa (ou pontos de corte)?
- É específico o bastante para pontuar de forma consistente, sem ambiguidade?
- Está alinhado ao enunciado da questão?

Marque \`adequate: false\` quando o critério for vago, ausente, genérico demais ("avaliar se está correto") ou desalinhado. Liste 1–3 \`issues\` curtas (o que falta) e, quando útil, uma \`suggestion\` de uma frase de como melhorar. Se estiver bom, \`adequate: true\`, \`issues: []\`, \`suggestion: ""\`.

Seja construtivo e conciso, em português. NÃO reescreva a rubrica inteira; só aponte o essencial.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{ "items": [ { "id": <id da questão>, "adequate": <bool>, "issues": ["..."], "suggestion": "" } ] }`;
    }

    /**
     * @param {object} p
     * @param {Array<{id:number|string, question:string, answer:string}>} p.criteria
     * @param {object|null} p.meterCtx
     * @returns {Promise<Array<{id:any, adequate:boolean, issues:string[], suggestion:string}>>}
     */
    async check({ criteria, meterCtx = null }) {
        const list = Array.isArray(criteria) ? criteria : [];
        if (!list.length) return [];

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const rendered = list.map((c, i) =>
            `QUESTÃO ${i + 1} (id ${c.id}):
Enunciado: ${String(c.question || "").trim() || "(vazio)"}
Critério de pontuação: ${String(c.answer || "").trim() || "(vazio)"}`).join("\n\n");
        const userText = `Revise os critérios de pontuação abaixo.\n\n${rendered}`;

        const { items } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:RubricCheck",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: CHECK_SCHEMA, schemaName: "rubric_criterion_check", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => {
                const arr = Array.isArray(parsed.items) ? parsed.items : [];
                const out = arr.map(it => ({
                    id: it.id,
                    adequate: !!it.adequate,
                    issues: Array.isArray(it.issues) ? it.issues.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [],
                    suggestion: typeof it.suggestion === "string" ? it.suggestion.trim() : "",
                }));
                return { items: out };
            },
        });
        log.info("AGENT:RubricCheck", `ok itens=${items.length} inadequados=${items.filter(i => !i.adequate).length}`);
        return items;
    }
}

// JSON Schema strict. Um item por questão avaliada.
const CHECK_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "adequate", "issues", "suggestion"],
                properties: {
                    id: { type: ["number", "string"] },
                    adequate: { type: "boolean" },
                    issues: { type: "array", items: { type: "string" } },
                    suggestion: { type: "string" },
                },
            },
        },
    },
};

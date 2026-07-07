import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * OralRubricBuilderAgent
 *
 * Gera, a partir da PERGUNTA + RESPOSTA ESPERADA de uma questão da prova oral, uma
 * RUBRICA DETALHADA (mini-prompt) que o avaliador aplicará para pontuar a resposta
 * do aluno. A rubrica descreve CINCO níveis de qualidade, ancorados nas notas
 * 0 / 2,5 / 5 / 7,5 / 10 (equivalentes a 0 / 0,25 / 0,5 / 0,75 / 1), cada um com
 * critérios concretos derivados da resposta. Também sugere o PESO da questão pela
 * complexidade da pergunta+resposta.
 *
 * Roda no setup da prova (lote ou por questão), a pedido do professor. Requer uma
 * resposta esperada não-vazia (sem ela, não há do que gerar — o professor escreve
 * a rubrica à mão).
 *
 * Audience: professor_via_ui (a rubrica é lida/editada pelo professor).
 *
 * Output JSON contract (espelhado em SCHEMA):
 *   { "rubric": "<mini-prompt com os 5 níveis>", "weight": <inteiro 1..5> }
 */
export class OralRubricBuilderAgent {
    static TYPE = "oral_rubric_builder";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OralRubricBuilderAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: escrever a RUBRICA DE PONTUAÇÃO de UMA questão de prova oral, a partir da pergunta e da resposta esperada (gabarito) que o professor forneceu. Essa rubrica será usada por outro agente para dar a nota da resposta falada do aluno.

A rubrica é um texto curto e objetivo que define CINCO níveis de qualidade, ancorados nas notas 0 / 2,5 / 5 / 7,5 / 10. Para cada nível, descreva concretamente o que a resposta do aluno precisa conter (com base na resposta esperada) para merecê-lo. Progrida do mais completo/correto (10) ao ausente/errado (0):
- 10: resposta completa e correta — o que exatamente caracteriza isso, olhando a resposta esperada.
- 7,5: correta com lacunas menores.
- 5: parcial — acerta o essencial mas falta parte relevante.
- 2,5: muito incompleta ou com equívoco importante.
- 0: não respondeu, fugiu do ponto ou errou o essencial.

REGRAS:
- Baseie os critérios na RESPOSTA ESPERADA fornecida; NÃO invente fatos fora dela. Se a resposta esperada for curta, ainda assim distribua os níveis de forma sensata (ex.: por quantidade de elementos corretos citados).
- Escreva em português do Brasil, direto, no formato de instrução para quem vai pontuar (ex.: "10 se o aluno explica X e Y com exemplo; 7,5 se explica X e Y sem exemplo; 5 se explica só X; 2,5 se menciona o tema sem explicar; 0 se não aborda ou erra").
- A rubrica é para o PROFESSOR/avaliador — pode citar o gabarito à vontade (nunca vai ao aluno).
- "weight": um inteiro de 1 a 5 sugerindo o peso da questão pela complexidade da pergunta e da profundidade esperada da resposta (1 = pergunta simples/factual; 5 = pergunta complexa/dissertativa). Na dúvida, 1.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{ "rubric": "<mini-prompt com os 5 níveis, ancorados em 0 / 2,5 / 5 / 7,5 / 10>", "weight": <inteiro 1 a 5> }`;
    }

    /**
     * @param {object} p
     * @param {string} p.question - enunciado da pergunta
     * @param {string} p.answer   - resposta esperada (gabarito) — obrigatória
     * @param {object|null} p.meterCtx
     * @returns {Promise<{rubric:string, weight:number}>}
     */
    async build({ question, answer, meterCtx = null }) {
        const q = String(question ?? "").trim();
        const a = String(answer ?? "").trim();
        if (!a) throw new Error("OralRubricBuilder: resposta esperada vazia (nada para gerar)");

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const userText = `PERGUNTA:
${q || "(sem enunciado)"}

RESPOSTA ESPERADA (gabarito):
${a}

Escreva a rubrica dos 5 níveis e sugira o peso.`;

        const { rubric, weight } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralRubricBuilder",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: SCHEMA, schemaName: "oral_rubric", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => {
                const rub = typeof parsed.rubric === "string" ? parsed.rubric.trim() : "";
                if (!rub) throw new Error("OralRubricBuilder: rubric vazia");
                let w = Math.round(Number(parsed.weight));
                if (!Number.isFinite(w) || w < 1) w = 1;
                if (w > 5) w = 5;
                return { rubric: rub, weight: w };
            },
        });
        log.info("AGENT:OralRubricBuilder", `ok weight=${weight} len=${rubric.length}`);
        return { rubric, weight };
    }
}

// JSON Schema strict. Limites do weight garantidos no código (validate).
const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["rubric", "weight"],
    properties: {
        rubric: { type: "string" },
        weight: { type: "number" },
    },
};

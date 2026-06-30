import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { GRADE_MIN, GRADE_MAX } from "../lib/rubric.js";

/**
 * GradingAgent
 *
 * Calcula a NOTA de UM critério de rubrica para uma entrevista. Recebe a
 * avaliação interna completa (relatório do InterviewEvaluatorAgent) e o prompt
 * do critério (definido pelo professor) e devolve uma nota 0–10 + justificativa.
 *
 * Uma chamada POR critério: o `prompt` do critério é a instrução específica
 * daquele cálculo, aplicada sobre o relatório inteiro. Assim cada critério é
 * isolado e fiel ao "o prompt será aplicado para seu cálculo". A nota FINAL
 * (média ponderada) é calculada em código (lib/rubric.js#weightedFinal), não
 * aqui — mais confiável que pedir a média ao modelo.
 *
 * Audiência professor_via_ui: a nota e a justificativa são lidas pelo professor.
 *
 * Output JSON contract (espelhado em GRADE_SCHEMA):
 *   { "score": <número 0–10>, "justification": "<1–2 frases>" }
 */
export class GradingAgent {
    static TYPE = "grading";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for GradingAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: atribuir uma NOTA de ${GRADE_MIN} a ${GRADE_MAX} a UM critério de avaliação de uma entrevista já realizada, e justificá-la em 1–2 frases.

Você recebe, no input: (1) o CRITÉRIO — a instrução do professor que define o que medir e como; e (2) a AVALIAÇÃO INTERNA COMPLETA da entrevista (relatório estruturado feito sob a perspectiva do entrevistador). Aplique o critério SOBRE essa avaliação.

REGRAS:
- A nota é um número de ${GRADE_MIN} a ${GRADE_MAX} (pode ter uma casa decimal). ${GRADE_MIN} = pior; ${GRADE_MAX} = melhor. Use a escala inteira com bom senso — não infle nem rebaixe sistematicamente.
- Baseie-se SOMENTE no que a avaliação interna traz (conteúdo das respostas, consistência com a entrega, impressão do entrevistador, sinais de forma/autoria, ressalvas). Não invente fatos que não estão lá.
- Se a avaliação for de uma entrevista interrompida/curta ou tiver ressalvas (caveats), pondere isso e mencione na justificativa; não puna o respondente pelo que não foi perguntado.
- A justificativa é curta (1–2 frases), em português direto, dirigida ao PROFESSOR. Explique o que sustentou a nota.
- Siga a instrução do critério mesmo que ela peça uma ótica específica (ex.: satisfação do entrevistador). O critério manda no QUE medir; estas regras mandam no FORMATO.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{ "score": <número de ${GRADE_MIN} a ${GRADE_MAX}>, "justification": "<1–2 frases>" }`;
    }

    /**
     * @param {object} p
     * @param {object} p.internalReport - relatório do InterviewEvaluatorAgent
     * @param {object} p.criterion - { id, name, weight, prompt } (prompt = instrução do professor)
     * @param {object|null} p.meterCtx - contexto de billing
     * @returns {Promise<{score:number, justification:string}>}
     */
    async grade({ internalReport, criterion, meterCtx = null }) {
        if (!internalReport) throw new Error("Grading: missing internalReport");
        if (!criterion || typeof criterion.prompt !== "string" || !criterion.prompt.trim()) {
            throw new Error("Grading: missing criterion prompt");
        }

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const userText = `CRITÉRIO "${criterion.name}" (instrução do professor para este cálculo):
${criterion.prompt.trim()}

AVALIAÇÃO INTERNA COMPLETA (base para a nota):

${JSON.stringify(internalReport, null, 2)}`;

        const { score, justification } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:Grading",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: GRADE_SCHEMA, schemaName: "criterion_grade", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => {
                const s = clampScore(parsed.score);
                if (s == null) throw new Error(`Grading: score inválido "${parsed.score}"`);
                const j = typeof parsed.justification === "string" ? parsed.justification.trim() : "";
                if (!j) throw new Error("Grading: justification vazia");
                return { score: s, justification: j };
            },
        });
        log.info("AGENT:Grading", `ok criterio="${criterion.name}" nota=${score}`);
        return { score, justification };
    }
}

// Valida e normaliza a nota: número finito em [GRADE_MIN, GRADE_MAX],
// arredondado a 1 casa. Devolve null se não-numérica. Fora do intervalo é
// clampado (modelo às vezes estoura por pouco) em vez de falhar.
function clampScore(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.min(GRADE_MAX, Math.max(GRADE_MIN, n));
    return Math.round(clamped * 10) / 10;
}

// JSON Schema strict da nota de um critério. Strict não suporta minimum/maximum;
// os limites são garantidos no código (clampScore).
const GRADE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["score", "justification"],
    properties: {
        score: { type: "number" },
        justification: { type: "string" },
    },
};

import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * GradePenaltyAgent
 *
 * Critério FIXO de penalidade por alertas (proctoring na prova oral; autoria na
 * entrevista por mensagem). NÃO é um critério ponderado da rubrica: roda DEPOIS
 * do cálculo da nota e devolve um MULTIPLICADOR (0..1) aplicado à nota final.
 *
 * Recebe (1) os ALERTAS já resumidos em texto (o chamador renderiza a partir de
 * oral_proctor_json/oral_voice_json OU dos sinais de autoria da avaliação) e
 * (2) a POLÍTICA do professor (prompt) — que diz como transformar alertas em
 * penalidade. O DEFAULT (DEFAULT_PENALTY_PROMPT) é restrito: só reduz diante de
 * violação fragrante, no máximo −50% (multiplicador 0,5).
 *
 * Audiência professor_via_ui: a justificativa é lida pelo professor.
 *
 * Output JSON contract (espelhado em PENALTY_SCHEMA):
 *   { "multiplier": <número 0..1>, "justification": "<1–2 frases>" }
 */

// Política default (bem restrita). O professor pode substituir por um prompt seu.
export const DEFAULT_PENALTY_PROMPT = `Aplique penalidade SOMENTE em caso de violação FRAGRANTE e inequívoca dos critérios de integridade (ex.: ausência prolongada do candidato, presença clara de outra pessoa, uso de celular durante boa parte da prova, ou fortíssima suspeita de autoria não-própria). Nesses casos, reduza a nota em até 50% (multiplicador 0,5). Se os alertas forem leves, pontuais ou ambíguos, NÃO penalize (multiplicador 1,0). Na dúvida, não penalize — os alertas são sinais para revisão humana, não prova.`;

export class GradePenaltyAgent {
    static TYPE = "grade_penalty";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for GradePenaltyAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: decidir uma PENALIDADE sobre uma nota já calculada, a partir de ALERTAS de integridade e de uma POLÍTICA definida pelo professor.

Você recebe, no input: (1) a POLÍTICA — a instrução do professor que diz como transformar alertas em penalidade; e (2) os ALERTAS observados (proctoring de vídeo/voz na prova oral, ou sinais de autoria na entrevista). Devolva um MULTIPLICADOR entre 0 e 1 a ser aplicado à nota (1 = sem penalidade; 0,5 = metade; 0 = zera) e uma justificativa curta.

REGRAS:
- O multiplicador é um número entre 0 e 1. 1 = nenhuma penalidade; valores menores reduzem a nota proporcionalmente.
- Baseie-se SOMENTE nos alertas fornecidos e na política. Não invente violações que os alertas não indicam.
- Alertas são SINAIS para revisão humana, não prova. Na dúvida, prefira NÃO penalizar (multiplicador 1).
- Respeite a política do professor: ela manda no QUANTO e QUANDO penalizar; estas regras mandam no FORMATO.
- A justificativa é curta (1–2 frases), em português direto, dirigida ao PROFESSOR: explique por que penalizou (ou por que não penalizou).

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{ "multiplier": <número entre 0 e 1>, "justification": "<1–2 frases>" }`;
    }

    /**
     * @param {object} p
     * @param {string} p.alertsText - resumo textual dos alertas observados
     * @param {string} [p.policyPrompt] - política do professor (default se vazio)
     * @param {object|null} p.meterCtx
     * @returns {Promise<{multiplier:number, justification:string}>}
     */
    async assess({ alertsText, policyPrompt, meterCtx = null }) {
        const policy = typeof policyPrompt === "string" && policyPrompt.trim() ? policyPrompt.trim() : DEFAULT_PENALTY_PROMPT;
        const alerts = typeof alertsText === "string" && alertsText.trim() ? alertsText.trim() : "(nenhum alerta registrado)";

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const userText = `POLÍTICA DE PENALIDADE (instrução do professor):
${policy}

ALERTAS OBSERVADOS:
${alerts}`;

        const { multiplier, justification } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:GradePenalty",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: PENALTY_SCHEMA, schemaName: "grade_penalty", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => {
                const m = clampMultiplier(parsed.multiplier);
                if (m == null) throw new Error(`GradePenalty: multiplier inválido "${parsed.multiplier}"`);
                const j = typeof parsed.justification === "string" ? parsed.justification.trim() : "";
                if (!j) throw new Error("GradePenalty: justification vazia");
                return { multiplier: m, justification: j };
            },
        });
        log.info("AGENT:GradePenalty", `ok multiplier=${multiplier}`);
        return { multiplier, justification };
    }
}

// Multiplicador finito em [0,1], arredondado a 2 casas. null se não-numérico.
function clampMultiplier(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.min(1, Math.max(0, n));
    return Math.round(clamped * 100) / 100;
}

// JSON Schema strict. Limites garantidos no código (clampMultiplier).
const PENALTY_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["multiplier", "justification"],
    properties: {
        multiplier: { type: "number" },
        justification: { type: "string" },
    },
};

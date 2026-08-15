import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { normalizeRubricLevels, hasLevels, RUBRIC_LEVELS } from "../lib/oralRubric.js";

/**
 * OralRubricBuilderAgent
 *
 * Gera, a partir da PERGUNTA + RESPOSTA ESPERADA de uma questão da prova oral, a
 * RUBRICA ESTRUTURADA (issue #195): CINCO níveis de nota FIXA (10 / 7,5 / 5 / 2,5 /
 * 0), cada um com um CRITÉRIO (o que a resposta precisa demonstrar para merecer
 * aquela nota). Também sugere o PESO da questão pela complexidade.
 *
 * Roda no setup da prova (lote ou por questão), a pedido do professor. Requer uma
 * resposta esperada não-vazia.
 *
 * Audience: professor_via_ui (a rubrica é lida/editada pelo professor).
 *
 * Saída: { rubric_levels: [{score, criteria}]×5, weight: 1..5 }.
 */
export class OralRubricBuilderAgent {
    static TYPE = "oral_rubric_builder";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OralRubricBuilderAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: escrever a RUBRICA DE PONTUAÇÃO de UMA questão de prova oral, a partir da pergunta e da resposta esperada (gabarito) que o professor forneceu. Essa rubrica será usada por outro agente para dar a nota da resposta falada do aluno.

A rubrica tem CINCO NÍVEIS de nota FIXA — 10, 7,5, 5, 2,5 e 0 — e para CADA nível você escreve um CRITÉRIO: o que a resposta do aluno precisa DEMONSTRAR para merecer aquela nota, com base na resposta esperada. Progrida do mais completo/correto (10) ao ausente/errado (0):
- 10: resposta completa e correta — o que exatamente caracteriza isso, olhando a resposta esperada.
- 7,5: correta com lacunas menores.
- 5: parcial — acerta o essencial mas falta parte relevante.
- 2,5: muito incompleta ou com equívoco importante.
- 0: não respondeu, fugiu do ponto ou errou o essencial.

REGRAS:
- Baseie os critérios na RESPOSTA ESPERADA fornecida; NÃO invente fatos fora dela. Se a resposta esperada for curta, ainda assim distribua os níveis de forma sensata (ex.: por quantidade de elementos corretos citados).
- É uma prova ORAL: os critérios devem premiar o ENTENDIMENTO, não a redação. Escreva critérios que aceitem paráfrases, sinônimos e explicações com as próprias palavras — NÃO exija termos técnicos específicos nem a formulação exata do gabarito. Foque no que o aluno precisa DEMONSTRAR que entende, não em palavras que ele precisa dizer.
- Cada critério é uma frase curta e objetiva, em português do Brasil, dirigida a quem vai pontuar (ex.: para o nível 10, "demonstra entender X e Y e dá um exemplo").
- A rubrica é para o PROFESSOR/avaliador — pode citar o gabarito à vontade (nunca vai ao aluno).
- "weight": um inteiro de 1 a 5 sugerindo o peso da questão pela complexidade da pergunta e da profundidade esperada da resposta (1 = pergunta simples/factual; 5 = pergunta complexa/dissertativa). Na dúvida, 1.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois. "levels" com EXATAMENTE os cinco níveis, um por nota (10, 7.5, 5, 2.5, 0):
{ "levels": [ {"score":10,"criteria":"…"}, {"score":7.5,"criteria":"…"}, {"score":5,"criteria":"…"}, {"score":2.5,"criteria":"…"}, {"score":0,"criteria":"…"} ], "weight": <inteiro 1 a 5> }`;
    }

    // Valida/normaliza a saída do modelo em { rubric_levels, weight }. LANÇA se os
    // níveis vierem vazios (força retry).
    _validate(parsed) {
        const rubric_levels = normalizeRubricLevels(parsed.levels);
        if (!hasLevels(rubric_levels)) throw new Error("OralRubricBuilder: níveis vazios");
        let w = Math.round(Number(parsed.weight));
        if (!Number.isFinite(w) || w < 1) w = 1;
        if (w > 5) w = 5;
        return { rubric_levels, weight: w };
    }

    /**
     * @param {object} p
     * @param {string} p.question - enunciado da pergunta
     * @param {string} p.answer   - resposta esperada (gabarito) — obrigatória
     * @param {object|null} p.meterCtx
     * @returns {Promise<{rubric_levels:Array<{score:number,criteria:string}>, weight:number}>}
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

Escreva o critério de cada um dos 5 níveis (10, 7,5, 5, 2,5, 0) e sugira o peso.`;

        const { rubric_levels, weight } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralRubricBuilder",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: SCHEMA, schemaName: "oral_rubric", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => this._validate(parsed),
        });
        log.info("AGENT:OralRubricBuilder", `ok weight=${weight} níveis=${rubric_levels.filter(l => l.criteria).length}/5`);
        return { rubric_levels, weight };
    }

    /**
     * Versão em BLOCO (issue #194): recebe N questões (com id) e devolve N rubricas
     * (níveis) + pesos, AMARRADAS pelo id. Ignora itens sem resposta esperada. Se o
     * bloco INTEIRO falhar, lança — o caller trata cada item do bloco como erro
     * individual (isolamento preservado).
     * @param {object} p
     * @param {Array<{id:number,question:string,answer:string}>} p.items
     * @returns {Promise<Array<{id:number,rubric_levels:Array,weight:number}>>}
     */
    async buildBatch({ items, meterCtx = null }) {
        const list = (items || [])
            .map(it => ({ id: Number(it.id), q: String(it.question ?? "").trim(), a: String(it.answer ?? "").trim() }))
            .filter(it => Number.isFinite(it.id) && it.a);
        if (!list.length) return [];
        if (list.length === 1) { // bloco de 1 → caminho single
            const one = await this.build({ question: list[0].q, answer: list[0].a, meterCtx });
            return [{ id: list[0].id, rubric_levels: one.rubric_levels, weight: one.weight }];
        }
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}

# Em BLOCO
Você recebe VÁRIAS questões, cada uma com um "id". Gere UMA rubrica (os 5 níveis) por questão, seguindo TODAS as regras acima, e amarre cada rubrica ao "id" da sua questão (não dependa da ordem). RELEIA a resposta esperada de CADA questão — não copie os critérios da anterior. Devolva TODAS as questões recebidas.`;
        const userText = "Gere a rubrica (5 níveis) de CADA questão abaixo (uma por questão, amarrada pelo id). NÃO dependa da ordem.\n\n" +
            list.map(it => `[id ${it.id}]\nPERGUNTA:\n${it.q || "(sem enunciado)"}\n\nRESPOSTA ESPERADA (gabarito):\n${it.a}`).join("\n\n---\n\n");

        const { rubrics } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralRubricBuilder(batch)",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: SCHEMA_BATCH, schemaName: "oral_rubrics", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => {
                const arr = Array.isArray(parsed.rubrics) ? parsed.rubrics : [];
                const out = [];
                for (const r of arr) {
                    const id = Number(r.id);
                    if (!Number.isFinite(id)) continue;
                    try {
                        const { rubric_levels, weight } = this._validate(r);
                        out.push({ id, rubric_levels, weight });
                    } catch { /* item sem níveis válidos: pula (o caller reporta faltantes) */ }
                }
                if (!out.length) throw new Error("OralRubricBuilder(batch): nenhuma rubrica válida");
                return { rubrics: out };
            },
        });
        log.info("AGENT:OralRubricBuilder", `batch ok n=${rubrics.length}/${list.length}`);
        return rubrics;
    }
}

// JSON Schema strict. Notas fixas garantidas na normalização (normalizeRubricLevels).
const LEVEL_ITEM = {
    type: "object",
    additionalProperties: false,
    required: ["score", "criteria"],
    properties: {
        score: { type: "number" },
        criteria: { type: "string" },
    },
};
const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["levels", "weight"],
    properties: {
        levels: { type: "array", items: LEVEL_ITEM },
        weight: { type: "number" },
    },
};

// Schema do caminho em BLOCO (#194): N rubricas amarradas pelo id da questão.
const SCHEMA_BATCH = {
    type: "object",
    additionalProperties: false,
    required: ["rubrics"],
    properties: {
        rubrics: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "levels", "weight"],
                properties: {
                    id: { type: "number" },
                    levels: { type: "array", items: LEVEL_ITEM },
                    weight: { type: "number" },
                },
            },
        },
    },
};

// eslint: RUBRIC_LEVELS importado para referência de contrato (notas fixas).
void RUBRIC_LEVELS;

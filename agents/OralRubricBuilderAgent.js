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
- É uma prova ORAL: os níveis devem premiar o ENTENDIMENTO, não a redação. Escreva critérios que aceitem paráfrases, sinônimos e explicações com as próprias palavras — NÃO exija termos técnicos específicos nem a formulação exata do gabarito. Foque no que o aluno precisa DEMONSTRAR que entende, não em palavras que ele precisa dizer.
- Escreva em português do Brasil, direto, no formato de instrução para quem vai pontuar (ex.: "10 se o aluno demonstra entender X e Y e dá um exemplo; 7,5 se demonstra X e Y sem exemplo; 5 se demonstra só X; 2,5 se tangencia o tema sem explicar; 0 se não aborda ou erra o conceito").
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

    /**
     * Versão em BLOCO (issue #194): recebe N questões (com id) e devolve N
     * rubricas+pesos, AMARRADAS pelo id (não depende da ordem). Corta o overhead
     * de raciocínio por chamada sem diluir por questão. Ignora itens sem resposta
     * esperada. Se o bloco INTEIRO falhar, lança — o caller trata cada item do
     * bloco como erro individual (isolamento preservado).
     * @param {object} p
     * @param {Array<{id:number,question:string,answer:string}>} p.items
     * @returns {Promise<Array<{id:number,rubric:string,weight:number}>>}
     */
    async buildBatch({ items, meterCtx = null }) {
        const list = (items || [])
            .map(it => ({ id: Number(it.id), q: String(it.question ?? "").trim(), a: String(it.answer ?? "").trim() }))
            .filter(it => Number.isFinite(it.id) && it.a);
        if (!list.length) return [];
        if (list.length === 1) { // bloco de 1 → caminho single (schema mais simples)
            const one = await this.build({ question: list[0].q, answer: list[0].a, meterCtx });
            return [{ id: list[0].id, rubric: one.rubric, weight: one.weight }];
        }
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}

# Em BLOCO
Você recebe VÁRIAS questões, cada uma com um "id". Gere UMA rubrica por questão, seguindo TODAS as regras acima, e amarre cada rubrica ao "id" da sua questão (não dependa da ordem). RELEIA a resposta esperada de CADA questão — não copie o formato da anterior nem encurte as últimas. Devolva TODAS as questões recebidas.`;
        const userText = "Gere a rubrica de CADA questão abaixo (uma por questão, amarrada pelo id). NÃO dependa da ordem.\n\n" +
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
                    const rub = typeof r.rubric === "string" ? r.rubric.trim() : "";
                    if (!Number.isFinite(id) || !rub) continue;
                    let w = Math.round(Number(r.weight));
                    if (!Number.isFinite(w) || w < 1) w = 1;
                    if (w > 5) w = 5;
                    out.push({ id, rubric: rub, weight: w });
                }
                if (!out.length) throw new Error("OralRubricBuilder(batch): nenhuma rubrica válida");
                return { rubrics: out };
            },
        });
        log.info("AGENT:OralRubricBuilder", `batch ok n=${rubrics.length}/${list.length}`);
        return rubrics;
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
                required: ["id", "rubric", "weight"],
                properties: {
                    id: { type: "number" },
                    rubric: { type: "string" },
                    weight: { type: "number" },
                },
            },
        },
    },
};

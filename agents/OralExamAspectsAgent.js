// OralExamAspectsAgent
//
// A partir de cada pergunta + gabarito, gera 2–3 ASPECTOS DE COBERTURA: rótulos
// curtos de TÓPICO que uma resposta completa deveria tocar — NUNCA a resposta em
// si. Rodam no servidor (modelo rápido). Diferente do gabarito (que fica só no
// servidor), os ASPECTOS vão à sessão Realtime: o examinador os usa só para
// checar se o aluno deixou algum ponto de fora e chamar atenção, sem corrigir.
//
// Por isso o cuidado central: o aspecto diz O QUE abordar, não O QUE responder.

import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "integer" },
                    aspects: { type: "array", items: { type: "string" } },
                },
                required: ["id", "aspects"],
            },
        },
    },
    required: ["items"],
};

const SYS = `Você recebe perguntas de uma prova oral com seus gabaritos. Para CADA pergunta, gere de 2 a 3 ASPECTOS DE COBERTURA, em português do Brasil.

O que é um aspecto: um rótulo CURTO de tópico (2 a 6 palavras) que indica QUE PONTO uma resposta completa deveria abordar — para um examinador checar se o aluno deixou algo de fora.

REGRA DE OURO — o aspecto diz O QUE abordar, JAMAIS O QUE responder:
- BOM (rótulo de tópico): "número de camadas", "um exemplo de aplicação", "a diferença entre os dois", "a finalidade do protocolo".
- RUIM (revela a resposta): "são 7 camadas", "TCP é confiável e UDP não", "serve para resolver nomes em IP". NÃO faça isso.

Outras regras:
- No máximo 3 aspectos por pergunta; foque nos pontos realmente centrais.
- Se a resposta for trivial ou de um único ponto, devolva 1 aspecto ou lista vazia.
- Não copie trechos do gabarito. Não dê dicas que entreguem a resposta.
- Use o "id" exatamente como veio na entrada.
Retorne SOMENTE o JSON do schema.`;

export class OralExamAspectsAgent {
    static TYPE = "oral_exam_aspects";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OralExamAspectsAgent");
        this.client = openaiClient;
        this.model = model;
    }

    /**
     * @param {Array<{id?:number,question:string,answer:string}>} questions
     * @param {object|null} meterCtx
     * @returns {Promise<Array>} as mesmas questions, com `aspects:string[]` em cada
     */
    async generate(questions, meterCtx = null) {
        const list = (questions || []).map((q, i) => ({
            id: q.id ?? i + 1, question: q.question, answer: q.answer || "",
            hasAspects: Array.isArray(q.aspects) && q.aspects.length > 0,
        }));
        // Gera só para perguntas COM gabarito e SEM aspectos definidos (preserva edições do professor).
        const needing = list.filter(q => q.answer.trim() && !q.hasAspects);
        if (needing.length === 0) return (questions || []).map((q, i) => ({ ...q, id: q.id ?? i + 1, aspects: Array.isArray(q.aspects) ? q.aspects : [] }));

        const input = [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ questions: needing.map(q => ({ id: q.id, question: q.question, answer: q.answer })) }) }] }];
        let byId = new Map();
        try {
            byId = await runStructured({
                client: this.client, model: this.model, label: "AGENT:OralExamAspects",
                instructions: SYS, input, schema: SCHEMA, schemaName: "oral_exam_aspects", meterCtx,
                validate: (parsed) => {
                    const m = new Map();
                    for (const it of (parsed.items || [])) {
                        const aspects = (Array.isArray(it.aspects) ? it.aspects : [])
                            .map(a => String(a || "").trim()).filter(Boolean).slice(0, 3);
                        m.set(it.id, aspects);
                    }
                    return m;
                },
            });
        } catch (err) {
            // Aspectos são um aprimoramento — falha não deve quebrar o salvamento da prova.
            log.error("AGENT:OralExamAspects", `falhou (segue sem aspectos): ${err.message}`);
        }
        const out = (questions || []).map((q, i) => {
            const id = q.id ?? i + 1;
            const generated = byId.get(id);
            const existing = Array.isArray(q.aspects) ? q.aspects : [];
            return { ...q, id, aspects: (generated && generated.length) ? generated : existing };
        });
        log.info("AGENT:OralExamAspects", `aspectos gerados para ${[...byId.values()].filter(a => a.length).length}/${list.length} perguntas`);
        return out;
    }
}

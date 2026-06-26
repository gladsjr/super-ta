// OralExamExtractorAgent
//
// Lê um PDF de PROVA (perguntas e respostas/gabarito) e extrai a lista
// estruturada de perguntas. Roda UMA vez, no upload da prova pelo professor
// (modelo rápido). As RESPOSTAS são extraídas e guardadas no servidor (futura
// avaliação), mas NUNCA vão à sessão Realtime do aluno — só as perguntas.
//
// Audience: orchestrator_only (saída é dado estruturado, não fala ao aluno).

import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        questions: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    answer: { type: "string" },
                },
                required: ["question", "answer"],
            },
        },
    },
    required: ["questions"],
};

const SYS = `Você extrai a LISTA DE PERGUNTAS (e suas respostas/gabarito) de um PDF de prova ou lista de exercícios, em português do Brasil. O PDF mistura perguntas e, para cada uma, a resposta esperada (que pode estar logo abaixo da pergunta, numa seção de gabarito ao final, etc.).

Regras:
- Extraia CADA pergunta como um item, na ORDEM em que aparecem no documento.
- "question": o enunciado da pergunta, limpo (sem o número/marcador), pronto para ser FALADO a um aluno numa arguição oral.
- "answer": a resposta/gabarito correspondente àquela pergunta. Se uma pergunta não tiver resposta no PDF, devolva string vazia.
- NÃO invente perguntas nem respostas. Use exclusivamente o conteúdo do PDF.
- Se o documento não for uma prova com perguntas, devolva questions como lista vazia.
Retorne SOMENTE o JSON do schema.`;

export class OralExamExtractorAgent {
    static TYPE = "oral_exam_extractor";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OralExamExtractorAgent");
        this.client = openaiClient;
        this.model = model;
    }

    /**
     * @param {object} p
     * @param {string} p.examFileId - file_id do PDF da prova (input_file)
     * @param {object|null} p.meterCtx
     * @returns {Promise<Array<{id:number,question:string,answer:string}>>}
     */
    async extract({ examFileId, meterCtx = null }) {
        if (!examFileId) throw new Error("OralExamExtractor.extract: missing examFileId");
        const payload = {
            model: this.model,
            instructions: SYS,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: "Extraia as perguntas e respostas do PDF anexo." },
                    { type: "input_file", file_id: examFileId },
                ],
            }],
            text: { format: { type: "json_schema", name: "oral_exam_questions", strict: true, schema: SCHEMA } },
        };
        log.prompt("AGENT:OralExamExtractor", SYS);
        const r = await log.span("AGENT:OralExamExtractor", "extract.create", () =>
            meteredResponses(
                { ...(meterCtx || {}), agentLabel: "AGENT:OralExamExtractor", model: this.model },
                () => this.client.responses.create(payload)
            )
        );
        let parsed;
        try { parsed = JSON.parse(r.output_text || "{}"); }
        catch (err) {
            log.error("AGENT:OralExamExtractor", `invalid JSON: ${log.preview(r.output_text, 200)}`);
            throw new Error(`OralExamExtractor: invalid JSON (${err.message})`);
        }
        const raw = Array.isArray(parsed.questions) ? parsed.questions : [];
        const out = raw
            .map(q => ({ question: String(q.question || "").trim(), answer: String(q.answer || "").trim() }))
            .filter(q => q.question)
            .map((q, i) => ({ id: i + 1, ...q }));
        log.info("AGENT:OralExamExtractor", `extracted ${out.length} questions`);
        return out;
    }
}

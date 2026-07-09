// OralExamExtractorAgent
//
// Lê uma PROVA (PDF ou TXT com perguntas e respostas/gabarito) e extrai a lista
// estruturada de perguntas. Roda UMA vez, no upload da prova pelo professor
// (modelo rápido). As RESPOSTAS são extraídas e guardadas no servidor (futura
// avaliação), mas NUNCA vão à sessão Realtime do aluno — só as perguntas.
//
// Audience: orchestrator_only (saída é dado estruturado, não fala ao aluno).

import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";

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

// "answer" é sempre a RESPOSTA ESPERADA (gabarito) da questão. A rubrica de
// pontuação (critério detalhado) é gerada depois, a partir da resposta, pelo
// OralRubricBuilderAgent — não sai do PDF.
const SYS = `Você extrai a LISTA DE PERGUNTAS de um PDF de prova ou lista de exercícios, em português do Brasil, junto com a resposta esperada de cada uma. O documento mistura perguntas e, para cada uma, um conteúdo de correção (que pode estar logo abaixo da pergunta, numa seção ao final, etc.).

Regras:
- Extraia CADA pergunta como um item, na ORDEM em que aparecem no documento.
- "question": o enunciado da pergunta, limpo (sem o número/marcador), pronto para ser FALADO a um aluno numa arguição oral.
- "answer": a RESPOSTA ESPERADA (gabarito) correspondente àquela pergunta. Se uma pergunta não tiver resposta no PDF, devolva string vazia.
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
     * Fonte da prova: PDF (via file_id) OU texto cru (.txt). Forneça um dos dois.
     * @param {object} p
     * @param {string|null} p.examFileId - file_id do PDF da prova (input_file)
     * @param {string|null} p.examText   - conteúdo de um arquivo .txt da prova
     * @param {object|null} p.meterCtx
     * @returns {Promise<Array<{id:number,question:string,answer:string}>>}
     */
    async extract({ examFileId = null, examText = null, meterCtx = null }) {
        if (!examFileId && !examText) throw new Error("OralExamExtractor.extract: missing examFileId/examText");
        const content = examText
            ? [{ type: "input_text", text: `Extraia as perguntas e as respostas esperadas do texto de prova abaixo.\n\n---\n${examText}\n---` }]
            : [
                { type: "input_text", text: "Extraia as perguntas e as respostas esperadas do PDF anexo." },
                { type: "input_file", file_id: examFileId },
            ];
        const out = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralExamExtractor",
            instructions: SYS, input: [{ role: "user", content }],
            schema: SCHEMA, schemaName: "oral_exam_questions", meterCtx,
            // Sem id aqui: quem atribui id ESTÁVEL (do contador, sem reuso) é
            // db.setOralQuestions. Assim re-extrair não reusa ids de questões antigas.
            validate: (parsed) => (Array.isArray(parsed.questions) ? parsed.questions : [])
                .map(q => ({ question: String(q.question || "").trim(), answer: String(q.answer || "").trim() }))
                .filter(q => q.question),
        });
        log.info("AGENT:OralExamExtractor", `extracted ${out.length} questions`);
        return out;
    }
}

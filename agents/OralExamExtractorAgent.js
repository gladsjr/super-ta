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

// O 2º campo ("answer") muda de significado conforme o MODO de pontuação da prova:
// - deterministico: é a RESPOSTA ESPERADA (gabarito).
// - rubrica: é o CRITÉRIO de pontuação (como dar 0–10) daquela questão.
function sysFor(mode) {
    const second = mode === "rubrica"
        ? `- "answer": o CRITÉRIO DE PONTUAÇÃO daquela questão — a instrução de como atribuir uma nota de 0 a 10 à resposta do aluno (ex.: "10 se citou os três aspectos com exemplos; 5 se citou dois; 0 se genérico"). Se o documento trouxer uma rubrica/critério por questão, extraia-o; se trouxer apenas a resposta esperada, use-a como base do critério; se não houver nada, devolva string vazia (o professor escreve depois).`
        : `- "answer": a RESPOSTA ESPERADA (gabarito) correspondente àquela pergunta. Se uma pergunta não tiver resposta no PDF, devolva string vazia.`;
    return `Você extrai a LISTA DE PERGUNTAS de um PDF de prova ou lista de exercícios, em português do Brasil, junto com um segundo campo por pergunta. O documento mistura perguntas e, para cada uma, um conteúdo de correção (que pode estar logo abaixo da pergunta, numa seção ao final, etc.).

Regras:
- Extraia CADA pergunta como um item, na ORDEM em que aparecem no documento.
- "question": o enunciado da pergunta, limpo (sem o número/marcador), pronto para ser FALADO a um aluno numa arguição oral.
${second}
- NÃO invente perguntas nem respostas/critérios. Use exclusivamente o conteúdo do PDF.
- Se o documento não for uma prova com perguntas, devolva questions como lista vazia.
Retorne SOMENTE o JSON do schema.`;
}

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
    async extract({ examFileId = null, examText = null, mode = "deterministico", meterCtx = null }) {
        if (!examFileId && !examText) throw new Error("OralExamExtractor.extract: missing examFileId/examText");
        const content = examText
            ? [{ type: "input_text", text: `Extraia as perguntas e o segundo campo do texto de prova abaixo.\n\n---\n${examText}\n---` }]
            : [
                { type: "input_text", text: "Extraia as perguntas e o segundo campo do PDF anexo." },
                { type: "input_file", file_id: examFileId },
            ];
        const out = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralExamExtractor",
            instructions: sysFor(mode), input: [{ role: "user", content }],
            schema: SCHEMA, schemaName: "oral_exam_questions", meterCtx,
            validate: (parsed) => (Array.isArray(parsed.questions) ? parsed.questions : [])
                .map(q => ({ question: String(q.question || "").trim(), answer: String(q.answer || "").trim() }))
                .filter(q => q.question)
                .map((q, i) => ({ id: i + 1, ...q })),
        });
        log.info("AGENT:OralExamExtractor", `extracted ${out.length} questions`);
        return out;
    }
}

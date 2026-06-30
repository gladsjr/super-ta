// OralExamEvaluatorAgent
//
// Avalia uma PROVA ORAL comparando as respostas faladas do aluno (transcrição)
// com o GABARITO do professor (perguntas + respostas esperadas), pergunta a
// pergunta. NÃO gera devolutiva nem nota — isso é manual pelo professor. Produz
// só o relatório de comparação (insumo para o professor decidir nota/devolutiva).
//
// Uma chamada ao principal_reasoning_model. Análise sempre em texto (a
// transcrição já é texto; nunca recebe áudio).

import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        per_question: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "integer" },
                    question: { type: "string" },
                    expected: { type: "string" },
                    student_answer: { type: "string" },
                    assessment: { type: "string", enum: ["correct", "partial", "incorrect", "not_answered"] },
                    comment: { type: "string" },
                },
                required: ["id", "question", "expected", "student_answer", "assessment", "comment"],
            },
        },
        summary: { type: "string" },
    },
    required: ["per_question", "summary"],
};

const SYS = `Você avalia uma PROVA ORAL, em português do Brasil. Você recebe:
1) o GABARITO do professor: a lista de perguntas e, para cada uma, a RESPOSTA ESPERADA;
2) a TRANSCRIÇÃO da prova: a conversa entre o examinador (que fez as perguntas) e o aluno (que respondeu falando), em ordem.

Sua tarefa: para CADA pergunta do gabarito, localizar na transcrição o que o aluno respondeu àquela pergunta e COMPARAR com a resposta esperada.

Para cada pergunta, produza:
- "id" e "question": o id e o texto da pergunta (do gabarito).
- "expected": a resposta esperada (do gabarito), resumida se for longa.
- "student_answer": o que o aluno efetivamente respondeu (extraído da transcrição). Se ele não respondeu àquela pergunta, use string vazia.
- "assessment": "correct" (respondeu o esperado), "partial" (parcialmente correto / incompleto), "incorrect" (errado ou fora do ponto) ou "not_answered" (não respondeu).
- "comment": 1-2 frases objetivas justificando, citando o que o aluno disse.

Depois, um "summary" (3-5 frases) do desempenho geral.

Regras:
- Baseie-se EXCLUSIVAMENTE na transcrição e no gabarito. Não invente respostas que o aluno não deu.
- A transcrição vem de fala (pode ter hesitações, repetições, erros de transcrição) — avalie o CONTEÚDO, não a forma.
- Seja justo e específico. NÃO atribua nota (isso é decisão do professor).
Retorne SOMENTE o JSON do schema.`;

export class OralExamEvaluatorAgent {
    static TYPE = "oral_exam_evaluator";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OralExamEvaluatorAgent");
        this.client = openaiClient;
        this.model = model;
    }

    /**
     * @param {object} p
     * @param {Array} p.questions   - gabarito [{id,question,answer}]
     * @param {Array} p.transcript  - [{role:'examiner'|'student', text}]
     * @param {object|null} p.meterCtx
     */
    async evaluate({ questions, transcript, meterCtx = null }) {
        if (!Array.isArray(questions) || questions.length === 0) throw new Error("OralExamEvaluator: gabarito vazio");
        if (!Array.isArray(transcript) || transcript.length === 0) throw new Error("OralExamEvaluator: transcrição vazia");

        const gabarito = questions.map(q => `Pergunta ${q.id}: ${q.question}\nResposta esperada: ${q.answer || "(sem gabarito)"}`).join("\n\n");
        const conversa = transcript.map(t => `${t.role === "examiner" ? "EXAMINADOR" : "ALUNO"}: ${t.text}`).join("\n");
        const userText = `**GABARITO (professor)**\n${gabarito}\n\n**TRANSCRIÇÃO DA PROVA**\n${conversa}\n\nAvalie pergunta a pergunta conforme o contrato e retorne o JSON.`;

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}\n\n${SYS}`;
        const parsed = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralExamEvaluator",
            instructions: systemPrompt, input: userText, promptLog: `${systemPrompt}\n\n${userText}`,
            schema: SCHEMA, schemaName: "oral_exam_evaluation", meterCtx,
            validate: (p) => {
                if (!Array.isArray(p.per_question)) throw new Error("OralExamEvaluator: per_question ausente");
                return p;
            },
        });
        log.info("AGENT:OralExamEvaluator", `ok per_question=${parsed.per_question.length}`);
        return parsed;
    }
}

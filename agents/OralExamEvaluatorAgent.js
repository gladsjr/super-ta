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

// O schema e o prompt RAMIFICAM pelo modo de pontuação da prova:
// - deterministico: cada questão traz uma RESPOSTA ESPERADA; o avaliador
//   classifica assessment (correct/partial/incorrect/not_answered).
// - rubrica: cada questão traz um CRITÉRIO; o avaliador dá um score 0–10.
function schemaFor(mode) {
    const base = {
        id: { type: "integer" },
        question: { type: "string" },
        expected: { type: "string" },       // o "2º campo": resposta esperada OU critério
        student_answer: { type: "string" },
        comment: { type: "string" },
    };
    const scoreField = mode === "rubrica"
        ? { score: { type: "number" } }
        : { assessment: { type: "string", enum: ["correct", "partial", "incorrect", "not_answered"] } };
    const props = { ...base, ...scoreField };
    return {
        type: "object",
        additionalProperties: false,
        properties: {
            per_question: {
                type: "array",
                items: { type: "object", additionalProperties: false, properties: props, required: Object.keys(props) },
            },
            summary: { type: "string" },
        },
        required: ["per_question", "summary"],
    };
}

function sysFor(mode) {
    const rubrica = mode === "rubrica";
    const secondField = rubrica
        ? `um CRITÉRIO DE PONTUAÇÃO (como atribuir uma nota de 0 a 10 à resposta)`
        : `a RESPOSTA ESPERADA`;
    const perQ = rubrica
        ? `- "expected": o critério de pontuação daquela questão (do professor), resumido se for longo.
- "student_answer": o que o aluno efetivamente respondeu (da transcrição). Vazio se não respondeu.
- "score": uma NOTA de 0 a 10 para a resposta do aluno, APLICANDO O CRITÉRIO daquela questão. Seja fiel ao critério.
- "comment": 1-2 frases objetivas justificando a nota, citando o que o aluno disse.`
        : `- "expected": a resposta esperada (do gabarito), resumida se for longa.
- "student_answer": o que o aluno efetivamente respondeu (da transcrição). Vazio se não respondeu.
- "assessment": "correct" (respondeu o esperado), "partial" (parcial/incompleto), "incorrect" (errado/fora do ponto) ou "not_answered" (não respondeu).
- "comment": 1-2 frases objetivas justificando, citando o que o aluno disse.`;
    return `Você avalia uma PROVA ORAL, em português do Brasil. Você recebe:
1) o material do professor: a lista de perguntas e, para cada uma, ${secondField};
2) a TRANSCRIÇÃO da prova: a conversa entre o examinador (que fez as perguntas) e o aluno (que respondeu falando), em ordem.

Sua tarefa: para CADA pergunta, localizar na transcrição o que o aluno respondeu e avaliá-la.

Para cada pergunta, produza:
- "id" e "question": o id e o texto da pergunta.
${perQ}

Depois, um "summary" (3-5 frases) do desempenho geral.

Regras:
- Baseie-se EXCLUSIVAMENTE na transcrição e no material do professor. Não invente respostas que o aluno não deu.
- A transcrição vem de fala (pode ter hesitações, repetições, erros de transcrição) — avalie o CONTEÚDO, não a forma.
- Seja justo e específico.
Retorne SOMENTE o JSON do schema.`;
}

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
    async evaluate({ questions, transcript, mode = "deterministico", meterCtx = null }) {
        if (!Array.isArray(questions) || questions.length === 0) throw new Error("OralExamEvaluator: gabarito vazio");
        if (!Array.isArray(transcript) || transcript.length === 0) throw new Error("OralExamEvaluator: transcrição vazia");

        const secondLabel = mode === "rubrica" ? "Critério de pontuação" : "Resposta esperada";
        const gabarito = questions.map(q => `Pergunta ${q.id}: ${q.question}\n${secondLabel}: ${q.answer || "(vazio)"}`).join("\n\n");
        const conversa = transcript.map(t => `${t.role === "examiner" ? "EXAMINADOR" : "ALUNO"}: ${t.text}`).join("\n");
        const userText = `**MATERIAL DO PROFESSOR**\n${gabarito}\n\n**TRANSCRIÇÃO DA PROVA**\n${conversa}\n\nAvalie pergunta a pergunta conforme o contrato e retorne o JSON.`;

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}\n\n${sysFor(mode)}`;
        const parsed = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralExamEvaluator",
            instructions: systemPrompt, input: userText, promptLog: `${systemPrompt}\n\n${userText}`,
            schema: schemaFor(mode), schemaName: "oral_exam_evaluation", meterCtx,
            validate: (p) => {
                if (!Array.isArray(p.per_question)) throw new Error("OralExamEvaluator: per_question ausente");
                return p;
            },
        });
        log.info("AGENT:OralExamEvaluator", `ok per_question=${parsed.per_question.length}`);
        return parsed;
    }
}

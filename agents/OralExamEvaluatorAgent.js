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
import { rubricForPrompt } from "../lib/oralRubric.js";

// Modelo ÚNICO de pontuação: cada questão traz uma RUBRICA detalhada (5 níveis) e o
// avaliador dá um score ANCORADO em 0 / 2,5 / 5 / 7,5 / 10.
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
                    student_answer: { type: "string" },
                    score: { type: "number" },
                    comment: { type: "string" },
                },
                required: ["id", "question", "student_answer", "score", "comment"],
            },
        },
        summary: { type: "string" },
    },
    required: ["per_question", "summary"],
};

const SYS = `Você avalia uma PROVA ORAL, em português do Brasil. Você recebe:
1) o material do professor: a lista de perguntas e, para cada uma, uma RUBRICA de pontuação com 5 níveis, ancorados nas notas 0 / 2,5 / 5 / 7,5 / 10;
2) a TRANSCRIÇÃO da prova: a conversa entre o examinador (que fez as perguntas) e o aluno (que respondeu falando), em ordem.

Sua tarefa: para CADA pergunta, localizar na transcrição o que o aluno respondeu e pontuá-la APLICANDO A RUBRICA.

Para cada pergunta, produza:
- "id" e "question": o id e o texto da pergunta.
- "student_answer": o que o aluno efetivamente respondeu (da transcrição). Vazio se não respondeu.
- "score": a nota, escolhendo o NÍVEL da rubrica que melhor descreve a resposta e usando a ÂNCORA correspondente — apenas um destes valores: 0, 2.5, 5, 7.5 ou 10. Não use valores fora dessas âncoras.
- "comment": 1-2 frases objetivas justificando o nível escolhido, citando o que o aluno disse.

Depois, um "summary" (3-5 frases) do desempenho geral.

Regras:
- Baseie-se EXCLUSIVAMENTE na transcrição e na rubrica do professor. Não invente respostas que o aluno não deu.
- Avalie o ENTENDIMENTO, não a redação. É uma prova ORAL: aceite paráfrases, sinônimos, exemplos próprios e explicações informais. NÃO exija que o aluno use os mesmos termos, o mesmo vocabulário técnico ou a mesma formulação do gabarito/rubrica — se ele demonstra a ideia correta com as próprias palavras, dê o crédito. Não desconte por "não ter dito o termo X" quando o conceito está claramente presente.
- Seja generoso com a FORMA (hesitações, ordem, repetições, erros de transcrição de fala) e criterioso com o CONTEÚDO (a ideia está certa? completa?). Uma resposta correta em linguagem coloquial vale tanto quanto uma formal.
- Ao escolher o nível, pergunte "o aluno mostrou que entende isto?", não "ele repetiu o gabarito?". Fique no nível mais alto compatível com o que ele de fato demonstrou.
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
     * @param {Array} p.questions   - [{id, question, rubric, weight}] (rubric = critério)
     * @param {Array} p.transcript  - [{role:'examiner'|'student', text}]
     * @param {object|null} p.meterCtx
     */
    async evaluate({ questions, transcript, meterCtx = null }) {
        if (!Array.isArray(questions) || questions.length === 0) throw new Error("OralExamEvaluator: sem questões");
        if (!Array.isArray(transcript) || transcript.length === 0) throw new Error("OralExamEvaluator: transcrição vazia");

        const material = questions.map(q => `Pergunta ${q.id}: ${q.question}\nRubrica de pontuação (por nível):\n${rubricForPrompt(q) || "(sem rubrica)"}`).join("\n\n");
        const conversa = transcript.map(t => `${t.role === "examiner" ? "EXAMINADOR" : "ALUNO"}: ${t.text}`).join("\n");
        const userText = `**MATERIAL DO PROFESSOR**\n${material}\n\n**TRANSCRIÇÃO DA PROVA**\n${conversa}\n\nAvalie pergunta a pergunta conforme o contrato e retorne o JSON.`;

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

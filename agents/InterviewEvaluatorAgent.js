import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble, EXTEMPORANEOUS_ANSWER_PRINCIPLE } from "../lib/agentPreamble.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";

/**
 * InterviewEvaluatorAgent
 *
 * Avalia uma entrevista já realizada sob a PERSPECTIVA DO ENTREVISTADOR da
 * cena: o autor da entrega sustentou o trabalho diante daquela persona?
 * Funcionalidade do professor (botão na página da conversa, rota
 * /w/:workToken/submissions/:subToken/evaluation). NÃO dá nota ao trabalho
 * escrito — avalia o desempenho na arguição, ancorado no que está nos PDFs.
 *
 * Uma chamada ao principal_reasoning_model com: enunciado (PDF via
 * input_file), entrega (PDF via input_file), agenda do entrevistador
 * renderizada e a transcrição completa serializada em texto.
 *
 * Áudio NUNCA é enviado (diretriz permanente: análise é sempre em texto).
 * Quando a entrevista foi em modo áudio, entram a transcrição do STT e os
 * METADADOS das gravações (duração por gravação), nada de bytes.
 *
 * Resultado costuma ser cacheado em submissions.evaluation_json.
 *
 * Output JSON contract:
 *   {
 *     "overall": {
 *       "defense_quality": "strong" | "adequate" | "weak" | "poor",
 *       "authorship_confidence": "high" | "medium" | "low",
 *       "summary": "<3-6 frases>"
 *     },
 *     "interviewer_impression": "<parágrafo>",
 *     "per_question": [
 *       { "turn_index": <int>, "question_gist": "<resumo>",
 *         "answer_assessment": "convincing" | "partial" | "evasive" |
 *                               "inconsistent" | "unanswered",
 *         "comment": "<1-2 frases>", "evidence": "<trecho curto>" }
 *     ],
 *     "strengths": [ "<frase>" ],
 *     "weaknesses": [ "<frase>" ],
 *     "delivery": {
 *       "overall_impression": "natural" | "mixed" | "scripted" | "inconclusive",
 *       "observations": [ "<frase>" ]
 *     },
 *     "authorship_signals": [
 *       { "direction": "supports" | "questions", "signal": "<frase>", "where": "<turno/trecho>" }
 *     ],
 *     "follow_up_suggestions": [ "<pergunta>" ],
 *     "caveats": [ "<limitação desta avaliação>" ]
 *   }
 */

// Serializa o conversation_json num texto estável para o avaliador (abertura,
// turnos com perguntas/respostas/intervenções, perguntas puladas, encerramento).
// Exportada para teste.
export function renderTranscriptForEvaluation(conversation, _audioArtifacts = []) {
    // Sinais de FORMA/entrega (delivery) removidos: eram para inferir voz/leitura;
    // com o proctoring de vídeo, a integridade vem do vídeo — simplifica e reduz custo.
    const lines = [];
    const persona = conversation?.interviewer_persona;
    if (persona?.name) {
        lines.push(`Entrevistador da cena: ${persona.name}${persona.city ? ` (${persona.city})` : ""}`);
    }
    if (conversation?.student_label) {
        lines.push(`Outra ponta (rótulo da submissão): ${conversation.student_label}`);
    }
    lines.push("");

    const introMsgs = Array.isArray(conversation?.intro?.messages) ? conversation.intro.messages : [];
    if (introMsgs.length > 0) {
        lines.push("=== ABERTURA ===");
        for (const m of introMsgs) {
            lines.push(`${m.role === "assistant" ? "entrevistador" : "respondente"}: ${m.content ?? ""}`);
        }
        lines.push("");
    }

    const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
    for (const t of turns) {
        const planId = t?.question_metadata?.id;
        lines.push(`=== TURNO ${t.index} ${planId ? `(plan id ${planId})` : "(pergunta espontânea)"} ===`);
        lines.push(`PERGUNTA (entrevistador): ${t.question ?? ""}`);
        const ivs = Array.isArray(t.interventions) ? t.interventions : [];
        for (const iv of ivs) {
            lines.push(`  [intervenção: ${iv.type ?? "?"}]`);
            if (iv.student_message)    lines.push(`  respondente: ${iv.student_message}`);
            if (iv.assistant_response) lines.push(`  entrevistador: ${iv.assistant_response}`);
        }
        if (t.answer) {
            lines.push(`RESPOSTA FINAL (respondente): ${t.answer}`);
        } else {
            lines.push("RESPOSTA FINAL: (sem resposta registrada)");
        }
        lines.push("");
    }

    const skipped = Array.isArray(conversation?.skipped_questions) ? conversation.skipped_questions : [];
    if (skipped.length > 0) {
        lines.push("=== PERGUNTAS PLANEJADAS QUE NÃO FORAM FEITAS ===");
        for (const s of skipped) {
            lines.push(`- ${s.question ?? ""} (motivo: ${s.reason ?? "?"})`);
        }
        lines.push("");
    }

    const fin = conversation?.finalization;
    lines.push("=== ENCERRAMENTO ===");
    if (fin?.completion_reason) {
        lines.push(`Como terminou: ${fin.completion_reason}${fin.finalize_reason ? ` (finalize_reason: ${fin.finalize_reason})` : ""}`);
        if (fin.message) lines.push(`Despedida do entrevistador: ${fin.message}`);
        if (fin.student_comment) lines.push(`Comentário deixado pelo respondente após a entrevista: ${fin.student_comment}`);
    } else {
        lines.push("Entrevista NÃO finalizada formalmente (interrompida ou ainda em andamento).");
    }

    return lines.join("\n");
}

export class InterviewEvaluatorAgent {
    static TYPE = "interview_evaluator";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for InterviewEvaluatorAgent");
        this.client = openaiClient;
        this.model = model;
        // System prompt final = preâmbulo padronizado (lib/agentPreamble.js)
        // + este body. Audience professor_via_ui — o relatório é lido pelo
        // professor na página da conversa.
        this.systemPromptBody = `Sua função específica: avaliar uma entrevista JÁ REALIZADA sob a perspectiva do ENTREVISTADOR da cena (a persona da AGENDA). Você responde à pergunta que essa persona se faria ao final da conversa: "quem respondeu sustentou a entrega diante de mim?".

Você recebe: o documento motivador (PDF anexado — enunciado, briefing, RFP), a entrega sob avaliação (PDF anexado), a AGENDA do entrevistador e a TRANSCRIÇÃO completa da conversa. Avalie SOMENTE o desempenho na conversa, ancorado no que está nos documentos — você NÃO está corrigindo nem dando nota ao documento escrito em si.

COMO AVALIAR — encarne o olhar da persona:
- A persona da AGENDA tem objetivos, preocupações e critérios de decisão próprios. Uma resposta é "convincing" quando satisfaria ESSA persona nesse quesito, não quando soa academicamente completa.
- Confronte cada resposta com o que está NA ENTREGA: resposta que contradiz o próprio documento (número diferente, premissa trocada, recomendação incompatível) é sinal forte — classifique "inconsistent" e cite onde.
- Resposta que repete o documento sem conseguir ir além quando provocada, ou que escapa da pergunta, é "evasive" ou "partial" conforme o grau.
- Pondere as INTERVENÇÕES do turno: pedir esclarecimento é legítimo; precisar de vários follow-ups para chegar a uma resposta simples enfraquece a defesa.
- RESPOSTA PÓS-DICA (induzida): quando a resposta final veio DEPOIS de um follow-up do entrevistador que descreveu o que faltava (ou ofereceu alternativas), compare você mesmo as duas falas. Resposta que essencialmente devolve a formulação do entrevistador NÃO é demonstração de domínio: classifique o mérito pelo que o respondente trouxe POR CONTA PRÓPRIA (antes da dica), tipicamente "partial", e registre o padrão em weaknesses/caveats quando se repetir. Elogio do entrevistador na transição ("agora sim...") NÃO é evidência de mérito.

${EXTEMPORANEOUS_ANSWER_PRINCIPLE}

Consequência para VOCÊ, avaliador: quando o entrevistador pediu um número que exigiria recálculo e a resposta veio com direção + mecanismo + ordem de grandeza, isso é resposta COMPLETA — classifique pelo mérito do raciocínio, NUNCA como "evasive" por faltar o valor exato. Recusar-se a chutar um número na hora é sinal de seriedade, não de fraqueza.

A INTEGRIDADE "ao vivo" (autoria da fala, consulta externa) NÃO é sua tarefa — fica por conta da fiscalização por VÍDEO, que o professor revisa à parte. Avalie o CONTEÚDO da defesa; se algo no conteúdo levantar dúvida honesta (não reconhecer a própria entrega, fluência decorada sem conexão com a pergunta), registre em weaknesses/caveats como observação para o professor — nunca como acusação.

REGRAS DURAS:
- per_question: exatamente UM item por turno da transcrição, na mesma ordem, com o MESMO turn_index. Turno sem resposta registrada = "unanswered".
- "strong" exige a maioria dos turnos "convincing" e nenhum "inconsistent" grave. "poor" é para defesa que a persona consideraria falha (evasivas dominantes, contradições centrais, abandono).
- evidence: trecho CURTO citado da transcrição ou referência à seção/figura da entrega (ex.: "diz 12% na conversa; tabela 3 usa 8%"). Não invente citações.
- Entrevista interrompida, com poucas perguntas ou com problemas de áudio: avalie o que existe e registre a limitação em caveats — não puna o respondente pelo que não foi perguntado.
- follow_up_suggestions: 0 a 4 perguntas concretas que o professor poderia fazer PESSOALMENTE para dirimir as dúvidas que sobraram. Sem genericões.
- NUNCA proponha nota, conceito ou aprovação/reprovação — isso é decisão do professor.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{
  "overall": {
    "defense_quality": "strong" | "adequate" | "weak" | "poor",
    "summary": "<3-6 frases: o veredito da entrevista em si>"
  },
  "interviewer_impression": "<parágrafo: como a persona da agenda saiu desta conversa — o que a convenceu, o que ficou devendo, em registro profissional direto>",
  "per_question": [
    { "turn_index": 0,
      "question_gist": "<resumo curto da pergunta>",
      "answer_assessment": "convincing" | "partial" | "evasive" | "inconsistent" | "unanswered",
      "comment": "<1-2 frases>",
      "evidence": "<trecho curto ou referência>" }
  ],
  "strengths": [ "<ponto em que a defesa foi bem>" ],
  "weaknesses": [ "<ponto em que a defesa ficou devendo>" ],
  "follow_up_suggestions": [ "<pergunta concreta para o professor>" ],
  "caveats": [ "<limitação desta avaliação>" ]
}`;
    }

    /**
     * @param {object} p
     * @param {string} p.enunciadoFileId - file_id do PDF do enunciado (input_file)
     * @param {string} p.studentFileId   - file_id do PDF da entrega (input_file)
     * @param {string} p.interviewerYamlText - YAML cru do entrevistador
     * @param {object} p.conversation    - conversation_json parseado
     * @param {Array}  p.audioArtifacts  - metadados das gravações (pode ser vazio)
     * @param {boolean} p.expectSpontaneous - o trabalho declarou exigir "resposta de cabeça"
     * @param {object|null} p.meterCtx   - contexto de billing
     */
    async evaluate({ enunciadoFileId, studentFileId, interviewerYamlText, conversation, audioArtifacts = [], expectSpontaneous = false, meterCtx = null }) {
        if (!enunciadoFileId) throw new Error("InterviewEvaluator: missing enunciadoFileId");
        if (!studentFileId) throw new Error("InterviewEvaluator: missing studentFileId");
        if (!interviewerYamlText) throw new Error("InterviewEvaluator: missing interviewerYamlText");
        if (!conversation) throw new Error("InterviewEvaluator: missing conversation");

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const transcript = renderTranscriptForEvaluation(conversation, audioArtifacts);
        // Lacunas que o entrevistador registrou ao AVANÇAR em vez de insistir
        // (guardrail de insistência): são achados de avaliação de pleno direito
        // — o aluno teve a chance e não sanou o ponto.
        const openThreads = Array.isArray(conversation?.finalization?.open_threads)
            ? conversation.finalization.open_threads.filter(t => typeof t === "string" && t.trim())
            : [];
        const openThreadsBlock = openThreads.length ? `

**PONTOS NÃO RESOLVIDOS (registrados pelo entrevistador ao avançar, em vez de insistir)**
${openThreads.map(t => `- ${t}`).join("\n")}
Trate cada item acima como lacuna JÁ CARACTERIZADA na entrevista: o entrevistador deu a oportunidade, a resposta não sanou o ponto, e ele avançou por disciplina de condução (não por aceitação do conteúdo). Pese-os na avaliação como pontos não demonstrados.` : "";
        const userText = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**TRANSCRIÇÃO DA ENTREVISTA**
${transcript}${openThreadsBlock}

Documento motivador e entrega em anexo (PDFs). Avalie a entrevista acima sob a perspectiva do entrevistador da agenda e produza o relatório JSON conforme o contrato.`;

        // Saída estruturada estrita (json_schema): elimina o "JSON com vírgula
        // faltando" que já perdeu uma avaliação de 96s em produção (jun/2026).
        // one-shot e sem efeito colateral até o cache: re-tentar a chamada INTEIRA
        // em falha de API/parse/validação é seguro (só custa outra chamada).
        const parsed = await runStructured({
            client: this.client, model: this.model, label: "AGENT:InterviewEvaluator",
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: userText },
                    { type: "input_file", file_id: enunciadoFileId },
                    { type: "input_file", file_id: studentFileId },
                ],
            }],
            schema: REPORT_SCHEMA, schemaName: "interview_evaluation", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (p) => { this._validateReport(p); return p; },
        });
        log.info("AGENT:InterviewEvaluator", `ok defense=${parsed.overall.defense_quality} per_question=${parsed.per_question.length}`);
        return parsed;
    }

    _validateReport(r) {
        const VALID_DEFENSE = new Set(["strong", "adequate", "weak", "poor"]);
        const VALID_ASSESSMENT = new Set(["convincing", "partial", "evasive", "inconsistent", "unanswered"]);

        if (!r.overall || typeof r.overall !== "object") {
            throw new Error("InterviewEvaluator: missing overall");
        }
        if (!VALID_DEFENSE.has(r.overall.defense_quality)) {
            throw new Error(`InterviewEvaluator: invalid defense_quality "${r.overall.defense_quality}"`);
        }
        if (typeof r.overall.summary !== "string" || !r.overall.summary.trim()) {
            throw new Error("InterviewEvaluator: missing overall.summary");
        }
        if (typeof r.interviewer_impression !== "string" || !r.interviewer_impression.trim()) {
            throw new Error("InterviewEvaluator: missing interviewer_impression");
        }
        if (!Array.isArray(r.per_question)) {
            throw new Error("InterviewEvaluator: per_question must be array");
        }
        for (const q of r.per_question) {
            if (!Number.isInteger(q.turn_index)) {
                throw new Error(`InterviewEvaluator: invalid per_question turn_index "${q.turn_index}"`);
            }
            if (!VALID_ASSESSMENT.has(q.answer_assessment)) {
                throw new Error(`InterviewEvaluator: invalid answer_assessment "${q.answer_assessment}"`);
            }
        }
        for (const key of ["strengths", "weaknesses", "follow_up_suggestions", "caveats"]) {
            if (!Array.isArray(r[key])) {
                throw new Error(`InterviewEvaluator: ${key} must be array`);
            }
        }
    }
}

// JSON Schema do relatório para a saída estruturada estrita da Responses API
// (text.format type=json_schema). Regras do modo strict: todo objeto declara
// additionalProperties:false e lista TODAS as propriedades em required.
// Manter em sincronia com o contrato do systemPromptBody e _validateReport
// (que segue rodando como defesa em profundidade).
const REPORT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["overall", "interviewer_impression", "per_question", "strengths", "weaknesses", "follow_up_suggestions", "caveats"],
    properties: {
        overall: {
            type: "object",
            additionalProperties: false,
            required: ["defense_quality", "summary"],
            properties: {
                defense_quality: { type: "string", enum: ["strong", "adequate", "weak", "poor"] },
                summary: { type: "string" },
            },
        },
        interviewer_impression: { type: "string" },
        per_question: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["turn_index", "question_gist", "answer_assessment", "comment", "evidence"],
                properties: {
                    turn_index: { type: "integer" },
                    question_gist: { type: "string" },
                    answer_assessment: { type: "string", enum: ["convincing", "partial", "evasive", "inconsistent", "unanswered"] },
                    comment: { type: "string" },
                    evidence: { type: "string" },
                },
            },
        },
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
        follow_up_suggestions: { type: "array", items: { type: "string" } },
        caveats: { type: "array", items: { type: "string" } },
    },
};

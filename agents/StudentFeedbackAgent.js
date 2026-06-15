import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * StudentFeedbackAgent
 *
 * Deriva, da avaliação INTERNA do InterviewEvaluatorAgent, a DEVOLUTIVA que o
 * professor pode publicar para o aluno. A avaliação interna nunca é exposta
 * crua (princípio do sistema): ela carrega juízo de avaliação, sinais de
 * autoria e análise forense de forma — material que, lido pelo aluno, vira
 * acusação e ensina a burlar a detecção.
 *
 * A versão do aluno é FORMATIVA: como foi a conversa, o que sustentou bem,
 * o que ficou devendo em cada pergunta e o que estudar. Sem nota e sem juízo
 * interno cru (defense_quality/authorship_confidence). O professor é SOBERANO
 * sobre o conteúdo: por default a devolutiva fica no conteúdo, mas se as
 * diretrizes dele pedirem, ela comenta forma/entrega/espontaneidade — sempre
 * como observação calibrada, nunca como acusação.
 *
 * SANITIZAÇÃO:
 *   1. O prompt fixa a REGRA INVIOLÁVEL: nunca imputar causa (trapaça/IA/
 *      plágio/fraude); comentar a entrega só como observação, com gentileza e
 *      cautela com falso-positivo.
 *   2. O código varre o JSON gerado com FORBIDDEN_PATTERNS (vocabulário de
 *      ACUSAÇÃO); se algo vazar, re-tenta uma vez apontando o vazamento e,
 *      persistindo, FALHA — melhor não publicar do que publicar acusação crua.
 *
 * Output JSON contract (espelhado em STUDENT_FEEDBACK_SCHEMA):
 *   {
 *     "summary": "<como foi a entrevista, 2-4 frases formativas>",
 *     "per_question": [
 *       { "turn_index": <int>, "question_gist": "<resumo>",
 *         "feedback": "<1-3 frases: o que foi bem e o que faltou>" }
 *     ],
 *     "strengths": [ "<frase>" ],
 *     "improvement_areas": [ "<frase>" ],
 *     "study_suggestions": [ "<frase>" ]
 *   }
 */

// Vocabulário de ACUSAÇÃO que nunca pode aparecer cru na devolutiva do aluno.
//
// A devolutiva é FORMATIVA e o professor é SOBERANO sobre o conteúdo: ela PODE
// comentar forma/entrega/espontaneidade (tempo, "de cabeça", registro) quando
// as diretrizes do professor pedem — isso é governado pelo prompt, não por
// código. O que o código continua barrando é a imputação de CAUSA: trapaça,
// IA, plágio, "colou", "suspeita", fraude. Ao comentar a entrega, a devolutiva
// descreve a OBSERVAÇÃO ("demorou, soou preparado"), nunca acusa. Quem quiser
// acusar formalmente faz isso fora desta devolutiva automática.
export const FORBIDDEN_PATTERNS = [
    /autoria/i,
    /pl[áa]gio/i,
    /colagem|colou|colad[ao]/i,
    /intelig[êe]ncia artificial/i,
    /\bIA\b/,
    /chatgpt|gpt|llm/i,
    /gerad[ao] (por|em) (ia|m[áa]quina|modelo)/i,
    /suspeit/i,
    /fraude/i,
];

export function findForbiddenLeaks(reportObject) {
    const text = JSON.stringify(reportObject);
    return FORBIDDEN_PATTERNS.filter(re => re.test(text)).map(re => String(re));
}

// Validação de FORMA da devolutiva (sem o vínculo com o relatório interno).
// Usada pelo agente (que adiciona a checagem de contagem de per_question) e
// pela rota de edição manual do professor (PUT /student-version).
export function validateStudentFeedbackShape(r) {
    if (!r || typeof r !== "object") throw new Error("devolutiva deve ser um objeto");
    if (typeof r.summary !== "string" || !r.summary.trim()) {
        throw new Error("summary ausente ou vazio");
    }
    if (!Array.isArray(r.per_question)) {
        throw new Error("per_question deve ser array");
    }
    for (const q of r.per_question) {
        if (!Number.isInteger(q.turn_index)) {
            throw new Error(`turn_index inválido "${q.turn_index}"`);
        }
        if (typeof q.feedback !== "string" || !q.feedback.trim()) {
            throw new Error("per_question.feedback vazio");
        }
    }
    for (const key of ["strengths", "improvement_areas", "study_suggestions"]) {
        if (!Array.isArray(r[key])) {
            throw new Error(`${key} deve ser array`);
        }
    }
}

export class StudentFeedbackAgent {
    static TYPE = "student_feedback";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for StudentFeedbackAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: escrever a DEVOLUTIVA AO ENTREVISTADO a partir do relatório interno de avaliação de uma entrevista (JSON no input). O relatório interno foi escrito para o operador do sistema e NÃO pode ser mostrado cru; você produz a versão que a própria pessoa entrevistada vai ler.

PROPÓSITO E ESTRUTURA — a devolutiva tem DUAS camadas com papéis distintos:

1) O \`summary\` é o CORPO PRINCIPAL e AUTOSSUFICIENTE — é a comunicação do professor ao entrevistado, escrita conforme as DIRETRIZES dele, REINTERPRETANDO a avaliação INTEIRA (o que sustentou bem, o que ficou devendo, o que vale estudar). Ele tem de fazer sentido SOZINHO: NUNCA conte com os blocos de seção para comunicar algo essencial, porque o professor pode escolher não exibi-los. Se a crítica importa e o professor pede (ou o equilíbrio formativo exige), ela tem de estar AQUI, no summary — não terceirize as fraquezas para a seção "improvement_areas" achando que ela será mostrada.

2) Os blocos \`strengths\` / \`improvement_areas\` / \`study_suggestions\` são INCLUSÕES OPCIONAIS, exibidas ao leitor APENAS quando o professor liga o checkbox correspondente. São uma versão fiel e direta daquela parte da avaliação (listas curtas). Preencha a lista de uma seção SÓ quando ela for exibida (ver o bloco "SEÇÕES QUE O PROFESSOR ESCOLHEU EXIBIR" adiante); quando não for exibida, devolva a lista VAZIA e leve o conteúdo para o summary. Nunca deixe a crítica "morar" só numa lista que não será mostrada.

DIRETRIZES DO PROFESSOR (quando presentes no input): orientam tom, formato, extensão, ênfases E QUAIS ASPECTOS entram no \`summary\` ("mais acolhedor", "texto corrido em dois parágrafos", "destaque as fraquezas", "comente a espontaneidade/o tempo de resposta", "evite citar perguntas específicas"). Siga-as fielmente — o professor é SOBERANO sobre estilo, estrutura, extensão, ênfase E conteúdo do summary. A única coisa que diretriz nenhuma afrouxa é a REGRA INVIOLÁVEL de não imputar causa/acusar (abaixo).

FORMATO:
- summary: corpo principal autossuficiente; respeite a extensão/estilo que o professor pedir (de um parágrafo a alguns; texto corrido se pedido).
- per_question é OPCIONAL: use só quando comentários pergunta a pergunta agregarem (ou o professor pedir esse formato); se ele pedir texto corrido/qualitativo sem citar perguntas, devolva per_question: []. turn_index, quando houver, corresponde ao turno do relatório interno.

REGRAS DE CONTEÚDO (a parte mais importante da sua função):
- O professor é SOBERANO sobre QUE aspectos entram no summary. Por DEFAULT, sem pedido em contrário nas diretrizes, a devolutiva foca no CONTEÚDO (o que foi dito, o que sustentou, o que ficou devendo) e NÃO levanta por conta própria temas de forma/tempo/entrega/espontaneidade/autoria. MAS se as DIRETRIZES do professor pedirem para comentar um aspecto presente no relatório interno — espontaneidade, demora para responder, respostas que soaram preparadas/lidas, fluência, registro, ou qualquer dimensão de entrega —, você DEVE incluí-lo, resumindo fielmente o que o relatório interno traz sobre ele. Pedido do professor manda; não silencie um aspecto que ele pediu.
- AO comentar forma/entrega/espontaneidade (quando pedido): enquadre como OBSERVAÇÃO ligada à conversa, em segunda pessoa, com respeito, e CALIBRANDO pelo falso-positivo (sinais de tempo/forma erram: áudio ruim, nervosismo, pensar devagar — prefira "pareceu/soou" a "você fez"; "nesta atividade espera-se resposta na hora, e algumas respostas demoraram a começar e soaram preparadas"). Se o relatório interno NÃO trouxer o sinal, não o invente.
- REGRA INVIOLÁVEL (nenhuma diretriz a afrouxa): NUNCA impute a CAUSA nem acuse. Proibido afirmar trapaça, uso de IA, plágio, "colou", "suspeita" ou fraude. Descreva só o OBSERVADO, nunca a intenção ("as respostas demoraram e soaram preparadas", não "você usou IA"). Acusação formal, se o professor quiser, é decisão dele FORA desta devolutiva automática.
- NUNCA atribua nota, conceito, aprovação ou juízo global de qualidade ("defesa fraca", "insuficiente"). Os campos internos defense_quality/authorship_confidence não existem para o leitor.
- NUNCA copie as follow_up_suggestions do relatório interno (são o roteiro de investigação do operador).
- Critique CONTEÚDO, sempre ancorado no que foi dito ou no que está na entrega: premissa não justificada, contradição com o documento, resposta que escapou da pergunta, conceito mal explicado. Isso PODE e DEVE ser dito, com gentileza e precisão.
- Inconsistência entre a resposta e o documento entregue: relate como fato observável da CONVERSA ("na conversa você citou 12%, mas a tabela 3 usa 8% — vale alinhar"), nunca como insinuação sobre quem escreveu o documento.
- Elogio tem que ser específico (o que exatamente foi bem) — nada de elogio genérico de consolação.
- study_suggestions: 0 a 5 sugestões concretas de estudo/preparo ligadas às lacunas observadas ("revisitar o mecanismo de ajuste de dificuldade da rede", "praticar explicar o VPL por cenário sem consultar a planilha").
- Escreva em segunda pessoa ("você explicou bem...", "faltou conectar..."). Não use o nome de campo interno nem jargão do sistema.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{
  "summary": "<corpo principal: 1-3 parágrafos, como foi a entrevista, equilibrando o que sustentou e o que ficou devendo>",
  "per_question": [
    { "turn_index": 0,
      "question_gist": "<resumo curto da pergunta, na linguagem do leitor>",
      "feedback": "<1-3 frases formativas sobre a resposta>" }
  ],
  "strengths": [ "<ponto específico que foi bem>" ],
  "improvement_areas": [ "<ponto específico a melhorar, ancorado em conteúdo>" ],
  "study_suggestions": [ "<sugestão concreta de estudo/preparo>" ]
}`;
    }

    /**
     * @param {object} p
     * @param {object} p.internalReport - relatório do InterviewEvaluatorAgent
     * @param {string|null} p.guidelines - diretrizes do professor (works.feedback_guidelines)
     * @param {object} p.visibleSections - quais seções o professor decidiu EXIBIR ao aluno
     *        { strengths, improvement_areas, study_suggestions } (booleans). As não
     *        exibidas devem ter sua substância dobrada no summary.
     * @param {object|null} p.meterCtx  - contexto de billing
     */
    async derive({ internalReport, guidelines = null, visibleSections = null, meterCtx = null }) {
        if (!internalReport) throw new Error("StudentFeedback: missing internalReport");

        // Diz ao agente quais blocos de seção serão EXIBIDOS ao leitor. As
        // ocultas não aparecem — então sua substância relevante tem de ser
        // dobrada no summary (que é autossuficiente). interviewer_opinion não é
        // gerada aqui; só as três seções de conteúdo importam.
        const vs = visibleSections || {};
        const SECN = { strengths: "O que sustentou bem", improvement_areas: "O que pode melhorar", study_suggestions: "Sugestões de estudo" };
        const shown = [], hidden = [];
        for (const k of Object.keys(SECN)) (vs[k] === false ? hidden : shown).push(SECN[k]);
        const sectionsBlock = visibleSections ? `

SEÇÕES QUE O PROFESSOR ESCOLHEU EXIBIR (decisão dele) — isto MUDA o que vai no summary e o que vai nas listas:
- EXIBIDAS (vão como bloco fiel ao leitor): ${shown.length ? shown.join("; ") : "(nenhuma)"}.
- NÃO exibidas (o leitor NÃO verá o bloco): ${hidden.length ? hidden.join("; ") : "(nenhuma)"}.
REGRAS OBRIGATÓRIAS (sobrepõem-se ao formato default):
- Para cada seção EXIBIDA: preencha a lista correspondente (strengths/improvement_areas/study_suggestions) com itens fiéis e curtos.
- Para cada seção NÃO exibida: devolva a lista correspondente VAZIA ([]) e LEVE a substância dela para DENTRO do summary, reinterpretada conforme as diretrizes do professor. NÃO há outro lugar para esse conteúdo aparecer — se ficar só na lista vazia, ele SOME para o leitor.
- Em especial: se "O que pode melhorar" NÃO será exibido, os pontos fracos/a melhorar TÊM de estar escritos no summary. Uma devolutiva só com elogios, havendo pontos a melhorar no relatório interno, é ERRO. O equilíbrio (o que foi bem E o que faltou) é inegociável, salvo se o professor pedir explicitamente o contrário.` : "";

        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_ui" })}

${this.systemPromptBody}${sectionsBlock}`;
        const guidelinesBlock = typeof guidelines === "string" && guidelines.trim()
            ? `DIRETRIZES DO PROFESSOR para esta devolutiva (siga em estilo/estrutura/ênfase E quais aspectos incluir; só a REGRA INVIOLÁVEL de não acusar prevalece):
${guidelines.trim()}

`
            : "";
        // Lembrete final (posição de maior peso) quando há seção de crítica oculta.
        const hiddenReminder = (visibleSections && vs.improvement_areas === false)
            ? `\n\nLEMBRETE FINAL: "O que pode melhorar" NÃO será exibido como bloco. Logo, os pontos fracos/a melhorar identificados no relatório interno TÊM de aparecer escritos no summary (e a lista improvement_areas vai vazia). Devolutiva só com elogios aqui é erro.`
            : "";
        const userText = `${guidelinesBlock}RELATÓRIO INTERNO DA AVALIAÇÃO (não mostrar cru — derive a devolutiva conforme o contrato):

${JSON.stringify(internalReport, null, 2)}${hiddenReminder}`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            text: {
                format: {
                    type: "json_schema",
                    name: "student_feedback",
                    strict: true,
                    schema: STUDENT_FEEDBACK_SCHEMA,
                },
            },
        };

        log.prompt("AGENT:StudentFeedback", systemPrompt + "\n\n" + userText);

        // Tentativa 2 reaproveita o payload acrescentando o apontamento do
        // vazamento — o modelo corrige melhor sabendo O QUE vazou.
        const MAX_ATTEMPTS = 2;
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const response = await log.span("AGENT:StudentFeedback", `responses.create${attempt > 1 ? ` retry#${attempt}` : ""}`, () =>
                    meteredResponses(
                        { ...meterCtx, agentLabel: "AGENT:StudentFeedback", model: this.model },
                        () => this.client.responses.create(payload)
                    )
                );
                const text = response.output_text || "";
                const match = text.match(/\{[\s\S]*\}/);
                if (!match) throw new Error(`StudentFeedback: no JSON in response (${log.preview(text, 120)})`);
                const parsed = JSON.parse(match[0]);
                this._validateReport(parsed, internalReport);

                const leaks = findForbiddenLeaks(parsed);
                if (leaks.length > 0) {
                    const leakMsg = `vocabulário de acusação vazou na devolutiva: ${leaks.join(", ")}`;
                    if (attempt < MAX_ATTEMPTS) {
                        const guidance = `A devolutiva anterior usou vocabulário de ACUSAÇÃO (padrões: ${leaks.join(", ")}). Você PODE comentar forma/entrega/espontaneidade se o professor pediu, mas NUNCA imputando a causa: reescreva descrevendo só o observado ("as respostas demoraram e soaram preparadas"), sem afirmar trapaça, IA, plágio, "colou", "suspeita" ou fraude.`;
                        payload.input.push({ role: "user", content: [{ type: "input_text", text: guidance }] });
                    }
                    throw new Error(`StudentFeedback: ${leakMsg}`);
                }

                log.info("AGENT:StudentFeedback", `ok per_question=${parsed.per_question.length} strengths=${parsed.strengths.length} improvements=${parsed.improvement_areas.length}${attempt > 1 ? ` (na tentativa ${attempt})` : ""}`);
                return parsed;
            } catch (err) {
                lastErr = err;
                log.error("AGENT:StudentFeedback", `tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${err.message}`);
            }
        }
        throw lastErr;
    }

    _validateReport(r, internalReport) {
        validateStudentFeedbackShape(r);
        // per_question é OPCIONAL e pode cobrir só parte das perguntas; quando
        // presente, cada turn_index precisa existir no relatório interno.
        const validIdx = new Set((internalReport.per_question ?? []).map(q => q.turn_index));
        for (const q of r.per_question) {
            if (!validIdx.has(q.turn_index)) {
                throw new Error(`StudentFeedback: per_question turn_index ${q.turn_index} não existe no relatório interno`);
            }
        }
    }
}

// JSON Schema da devolutiva para a saída estruturada estrita da Responses API.
// Modo strict: additionalProperties:false e todas as propriedades em required.
const STUDENT_FEEDBACK_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "per_question", "strengths", "improvement_areas", "study_suggestions"],
    properties: {
        summary: { type: "string" },
        per_question: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["turn_index", "question_gist", "feedback"],
                properties: {
                    turn_index: { type: "integer" },
                    question_gist: { type: "string" },
                    feedback: { type: "string" },
                },
            },
        },
        strengths: { type: "array", items: { type: "string" } },
        improvement_areas: { type: "array", items: { type: "string" } },
        study_suggestions: { type: "array", items: { type: "string" } },
    },
};

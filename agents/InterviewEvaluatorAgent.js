import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble, EXTEMPORANEOUS_ANSWER_PRINCIPLE } from "../lib/agentPreamble.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { buildDeliveryReport } from "../lib/deliverySignals.js";

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

// Serializa o conversation_json (e metadados de áudio, se houver) num texto
// estável para o avaliador, com as métricas de forma/entrega de cada turno
// (lib/deliverySignals.js) anotadas junto à resposta. Exportada para teste.
export function renderTranscriptForEvaluation(conversation, audioArtifacts = []) {
    const delivery = buildDeliveryReport(conversation, audioArtifacts);
    const deliveryByTurn = new Map(delivery.turns.map(t => [t.index, t]));
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
        const d = deliveryByTurn.get(t.index);
        if (d) {
            const parts = [`${d.words} palavras`];
            if (d.latency_s != null) parts.push(`${d.latency_s}s de latência grossa do turno (inclui playback e follow-ups)`);
            if (d.cps != null) parts.push(`${d.cps} caracteres/s digitados`);
            if (d.recording) {
                if (d.recording.duration_s != null) parts.push(`gravação final de ${d.recording.duration_s}s`);
                if (d.recording.wps != null) parts.push(`${d.recording.wps} palavras/s ao falar`);
            }
            if (Array.isArray(d.think_pairs) && d.think_pairs.length > 0) {
                const tp = d.think_pairs.map(p => p.source === "client"
                    ? `${p.label} ${p.think_s}s até começar a falar (medido${p.words != null ? `, resposta de ${p.words} palavras` : ""})`
                    : `${p.label} ~${p.think_s}s até começar (aproximado, inclui a escuta da pergunta)`);
                parts.push(`tempo de pensamento por par: ${tp.join("; ")}`);
            }
            parts.push(`disfluências: ${d.disfluencies}`);
            parts.push(`registro escrito: ${d.written_register}`);
            parts.push(`polimento: ${d.polish}`);
            if (d.echo != null) parts.push(`eco da dica: ${d.echo}`);
            lines.push(`FORMA DA RESPOSTA: ${parts.join("; ")}.`);
            for (const f of d.flags) {
                lines.push(`SINAL AUTOMÁTICO DE FORMA: ${f}`);
            }
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

    lines.push("");
    lines.push("=== CONTEXTO DOS SINAIS DE FORMA ===");
    if (delivery.mode === "audio") {
        lines.push("Entrevista em modo VOZ: as falas do respondente acima são transcrições automáticas (STT) de gravações.");
        if (delivery.mapped_by === "unreliable") {
            lines.push("Não foi possível casar com segurança cada gravação ao seu turno — os tempos por gravação foram omitidos.");
        }
    } else {
        lines.push("Entrevista em modo TEXTO: o respondente digitou as respostas.");
    }
    for (const shift of delivery.register_shifts) {
        lines.push(`SINAL AUTOMÁTICO DE FORMA (conjunto): mudança de registro — ${shift}`);
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
- RESPOSTA PÓS-DICA (induzida): quando a resposta final veio DEPOIS de um follow-up do entrevistador que descreveu o que faltava (ou ofereceu alternativas), compare você mesmo as duas falas — e olhe o "eco da dica" na linha FORMA. Resposta que essencialmente devolve a formulação do entrevistador NÃO é demonstração de domínio: classifique o mérito pelo que o respondente trouxe POR CONTA PRÓPRIA (antes da dica), tipicamente "partial", e registre o padrão em weaknesses/caveats quando se repetir. Elogio do entrevistador na transição ("agora sim...") NÃO é evidência de mérito.

${EXTEMPORANEOUS_ANSWER_PRINCIPLE}

Consequência para VOCÊ, avaliador: quando o entrevistador pediu um número que exigiria recálculo e a resposta veio com direção + mecanismo + ordem de grandeza, isso é resposta COMPLETA — classifique pelo mérito do raciocínio, NUNCA como "evasive" por faltar o valor exato. Recusar-se a chutar um número na hora é sinal de seriedade, não de fraqueza.

FORMA E ENTREGA (dimensão holística — campo "delivery"):
Um entrevistador de verdade não ouve só o conteúdo: percebe ritmo, hesitação, cadência, registro de linguagem e tempo de reação. A transcrição traz, por turno, uma linha "FORMA DA RESPOSTA" (palavras, tempos, velocidade de fala/digitação, disfluências, registro escrito 0..1, polimento 0..1) e linhas "SINAL AUTOMÁTICO DE FORMA" quando alguma heurística disparou. Semântica dos principais:
- "registro escrito" alto numa FALA = subordinação e vocabulário de prosa que quase ninguém improvisa oralmente; combinado com ZERO disfluências numa resposta longa, é compatível com leitura de texto pronto.
- velocidade de digitação acima de ~22 caracteres/s em resposta longa = compatível com colagem.
- "tempo de pensamento por par" (modo voz) = o silêncio entre o áudio de CADA pergunta terminar de tocar e o respondente apertar gravar — medido por par (pergunta principal e cada follow-up), não só na resposta final. É o trecho que de fato representa "pensar antes de responder" (exclui o áudio da pergunta, rede, upload e transcrição). "(medido)" é preciso (instrumentado no navegador); "~Ns (aproximado)" é estimado por timestamps em entrevistas antigas e inclui a escuta da pergunta — mais ruidoso. Pensar um pouco é normal; um silêncio longo antes de uma resposta longa e polida — em qualquer par, inclusive follow-up — pode indicar consulta externa, e dispara um "SINAL AUTOMÁTICO DE FORMA" identificando o par. O número de "latência" da linha FORMA é o tempo GROSSO do turno inteiro (inclui playback/follow-ups) — informativo, não use como sinal de consulta.
- "gravou Xs mas disse quase nada" = abriu o microfone e quase não falou — possível tentativa de "começar" só para ganhar tempo (anti-gaming do início rápido).
- "mudança de registro" = resposta muito mais estruturada que a mediana do próprio respondente — sugere ajuda seletiva nas perguntas difíceis.
- "eco da dica" (0..1) = fração do vocabulário NOVO da resposta final que veio do follow-up do PRÓPRIO entrevistador (só existe quando houve follow-up). DIFERENTE dos demais sinais de forma, o eco fala da PROVENIÊNCIA do conteúdo: alto (≥0.4) indica que o conteúdo aceito foi ditado pela dica, não produzido pelo respondente — e aí a exceção: este sinal PODE rebaixar o mérito da resposta em per_question (ver "RESPOSTA PÓS-DICA" acima), porque não é forma, é autoria do conteúdo daquele turno.
Incorpore essas percepções na sua avaliação como a persona faria: comente-as em "delivery", deixe-as colorir o interviewer_impression e, quando convergirem com sinais de conteúdo, alimente os authorship_signals. São heurísticas com risco real de falso positivo (gente que digita rápido, fala formal por hábito, pensa devagar) — então NUNCA rebaixe o mérito de conteúdo de uma resposta (per_question) por sinal de forma, e NUNCA conclua autoria a partir de tempo isolado. Forma corrobora; conteúdo decide.

SOBRE AUTORIA (authorship_confidence e authorship_signals):
- Você emite SINAIS, nunca acusações. "questions" significa "valeria sondar pessoalmente", não "colou".
- Sinais que SUSTENTAM autoria: corrigir-se com naturalidade, recordar bastidores e tentativas descartadas, defender escolhas com vocabulário próprio, admitir limitações específicas do próprio trabalho, fala espontânea com disfluências naturais.
- Sinais que LEVANTAM dúvida: não reconhecer conteúdo central da própria entrega, fluência desproporcional em tema que o documento trata superficialmente (ou o inverso), respostas que parecem lidas/decoradas sem conexão com a pergunta concreta, sinais de forma convergentes (registro escrito + zero disfluência + latência longa) em respostas decisivas.

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
    "authorship_confidence": "high" | "medium" | "low",
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
  "delivery": {
    "overall_impression": "natural" | "mixed" | "scripted" | "inconclusive",
    "observations": [ "<percepção de forma/entrega, com o turno e o porquê>" ]
  },
  "authorship_signals": [
    { "direction": "supports" | "questions", "signal": "<o que foi observado>", "where": "<turno N / trecho>" }
  ],
  "follow_up_suggestions": [ "<pergunta concreta para o professor>" ],
  "caveats": [ "<limitação desta avaliação>" ]
}

Sobre "delivery": overall_impression resume como o respondente SOOU (natural = fala/digitação espontânea; scripted = entrega com cara de texto pronto; mixed = variou entre turnos; inconclusive = pouca informação de forma). observations: 0 a 6 itens concretos, cada um ancorado em turno(s).`;
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

        // Quando o trabalho declarou exigir espontaneidade ("de cabeça"), a
        // forma/entrega vira CRITÉRIO declarado — o campo delivery deixa de ser
        // só corroboração e passa a ser uma dimensão reportada de propósito.
        const spontaneityBlock = expectSpontaneous ? `

ESTE TRABALHO EXIGE RESPOSTA "DE CABEÇA" (CRITÉRIO DECLARADO AO RESPONDENTE):
O respondente foi avisado, na abertura, de que se espera resposta espontânea, na hora, com as próprias palavras — pode pensar, pausar, hesitar e se corrigir, mas NÃO consultar IA, pesquisar nem ler texto pronto. Portanto, neste trabalho, a dimensão "delivery" NÃO é só corroboração: é uma dimensão de avaliação por direito próprio, que o professor pediu para medir. Avalie em "delivery" se o respondente correspondeu a essa expectativa, usando as linhas de FORMA e os SINAIS automáticos:
- O que CUMPRE a expectativa (delivery="natural"): começar a falar em tempo razoável, fala conversacional COM hesitações/autocorreções/disfluências naturais, conteúdo construído na hora. ATENÇÃO: hesitar, gaguejar e se corrigir é PROVA A FAVOR, não defeito — não confunda "fluência polida" com espontaneidade; o monólogo perfeito demais é o suspeito.
- O que CONTRARIA (delivery="scripted"): textura de leitura (registro escrito + zero disfluência + ritmo constante), tempos de início longos seguidos de respostas longas e polidas, ou abrir o microfone e quase não falar (stall) repetidamente.
- "mixed" quando varia entre turnos; "inconclusive" quando há pouca informação de forma (ex.: modo texto curto, sem instrumentação).
REGRAS QUE PERMANECEM (mesmo sendo critério): conteúdo e espontaneidade são EIXOS SEPARADOS — nunca rebaixe o mérito de uma resposta em per_question por causa da forma. NUNCA acuse: você reporta evidências de forma para o PROFESSOR decidir o peso; um respondente lento, ansioso, não-nativo ou que pensa devagar pode disparar sinais sem ter feito nada errado. Em "delivery.observations", seja concreto (cite o turno e o sinal) e calibre a confiança honestamente.` : "";

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}${spontaneityBlock}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const transcript = renderTranscriptForEvaluation(conversation, audioArtifacts);
        const userText = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**TRANSCRIÇÃO DA ENTREVISTA**
${transcript}

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
        log.info("AGENT:InterviewEvaluator", `ok defense=${parsed.overall.defense_quality} authorship=${parsed.overall.authorship_confidence} per_question=${parsed.per_question.length}`);
        return parsed;
    }

    _validateReport(r) {
        const VALID_DEFENSE = new Set(["strong", "adequate", "weak", "poor"]);
        const VALID_AUTHORSHIP = new Set(["high", "medium", "low"]);
        const VALID_ASSESSMENT = new Set(["convincing", "partial", "evasive", "inconsistent", "unanswered"]);
        const VALID_DIRECTION = new Set(["supports", "questions"]);

        if (!r.overall || typeof r.overall !== "object") {
            throw new Error("InterviewEvaluator: missing overall");
        }
        if (!VALID_DEFENSE.has(r.overall.defense_quality)) {
            throw new Error(`InterviewEvaluator: invalid defense_quality "${r.overall.defense_quality}"`);
        }
        if (!VALID_AUTHORSHIP.has(r.overall.authorship_confidence)) {
            throw new Error(`InterviewEvaluator: invalid authorship_confidence "${r.overall.authorship_confidence}"`);
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
        const VALID_DELIVERY = new Set(["natural", "mixed", "scripted", "inconclusive"]);
        if (!r.delivery || typeof r.delivery !== "object") {
            throw new Error("InterviewEvaluator: missing delivery");
        }
        if (!VALID_DELIVERY.has(r.delivery.overall_impression)) {
            throw new Error(`InterviewEvaluator: invalid delivery.overall_impression "${r.delivery.overall_impression}"`);
        }
        if (!Array.isArray(r.delivery.observations)) {
            throw new Error("InterviewEvaluator: delivery.observations must be array");
        }
        if (!Array.isArray(r.authorship_signals)) {
            throw new Error("InterviewEvaluator: authorship_signals must be array");
        }
        for (const s of r.authorship_signals) {
            if (!VALID_DIRECTION.has(s.direction)) {
                throw new Error(`InterviewEvaluator: invalid authorship_signal direction "${s.direction}"`);
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
    required: ["overall", "interviewer_impression", "per_question", "strengths", "weaknesses", "delivery", "authorship_signals", "follow_up_suggestions", "caveats"],
    properties: {
        overall: {
            type: "object",
            additionalProperties: false,
            required: ["defense_quality", "authorship_confidence", "summary"],
            properties: {
                defense_quality: { type: "string", enum: ["strong", "adequate", "weak", "poor"] },
                authorship_confidence: { type: "string", enum: ["high", "medium", "low"] },
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
        delivery: {
            type: "object",
            additionalProperties: false,
            required: ["overall_impression", "observations"],
            properties: {
                overall_impression: { type: "string", enum: ["natural", "mixed", "scripted", "inconclusive"] },
                observations: { type: "array", items: { type: "string" } },
            },
        },
        authorship_signals: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["direction", "signal", "where"],
                properties: {
                    direction: { type: "string", enum: ["supports", "questions"] },
                    signal: { type: "string" },
                    where: { type: "string" },
                },
            },
        },
        follow_up_suggestions: { type: "array", items: { type: "string" } },
        caveats: { type: "array", items: { type: "string" } },
    },
};

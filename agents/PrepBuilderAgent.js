// PrepBuilderAgent
//
// Substitui MapBuilderAgent + PlanBuilderAgent no /upload. Ponto de entrada:
//
//   buildPrep({ studentFileId, enunciadoFileId, interviewerYamlText, questionCount })
//      → { analysis, plan }. Tenta produzir os dois numa ÚNICA chamada
//        (_mergedPrep) — que NÃO reenvia os PDFs, cortando ~metade do
//        custo/tempo da prep — e cai automaticamente para as duas chamadas
//        serializadas abaixo se a chamada única vier incompleta/inválida.
//
// As duas etapas (também usadas como fallback e reutilizáveis à parte):
//
//   1. analyzeWork(...) → JSON com `summary`, `assessment` (strengths/weaknesses/
//      critical_points/authorship_doubts/internal_contradictions) e
//      `evidence_index` (pontos do PDF que valem checar, com âncoras).
//
//   2. buildPlan({ analysis, ... }) → JSON com `questions: [...]` no MESMO shape
//      do interview_plan atual. Recebe `analysis` como input principal — as
//      perguntas cobrem prioritariamente contradições/critical_points/weaknesses,
//      usando o evidence_index para citar partes específicas.
//
// Por que a chamada única é segura (com a rede de proteção): o output combinado
// (análise + plano) cabe folgado no teto de saída para questionCount ≤ 10
// (validado empiricamente), e o `plan` continua raciocinando sobre a `analysis`
// que o próprio modelo produz na sub-rotina 1. Em qualquer sinal de truncamento
// ou shape inválido, buildPrep refaz pela via de duas chamadas.
//
// Audience: orchestrator_only (saída alimenta o super-orquestrador e o
// professor; nunca vai direto pro aluno).

import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import {
    loadInterviewPromptTemplate,
    renderInterviewPrompt,
    parseQuestionsJSON,
} from "../lib/interviewPrompt.js";

export class PrepBuilderAgent {
    static TYPE = "prep_builder";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for PrepBuilderAgent");
        this.client = openaiClient;
        this.model = model;

        this.analyzeSystemBody = `Sua função: analisar a entrega sob avaliação (PDF anexado) em relação ao documento motivador (PDF anexado — enunciado, briefing, RFP, etc.) e à agenda do entrevistador (texto fornecido), produzindo um JSON estruturado que vai alimentar o gerador do plano de perguntas (próxima etapa) e o super-orquestrador que conduz a conversa.

Você está rodando uma vez por conversa, antes da primeira pergunta. Sua saída é contexto compactado, NÃO conversa endereçada à outra ponta da cena.

PASSO OBRIGATÓRIO ANTES DE PRODUZIR O JSON — busca de contradições internas:
Faça uma varredura DEDICADA da entrega procurando contradições internas. Isso é fonte de PRIMEIRA ORDEM para perguntas de entrevista. Tipos a procurar:
  - Valores/números divergentes em pontos diferentes (ex.: taxa de retorno é 8% na seção 2 e 12% na planilha; receita Y1 é R$ 1M no texto e R$ 1.2M no gráfico).
  - Premissa adotada em um ponto vs cálculo/conclusão que requer premissa diferente (ex.: assume cenário base na metodologia mas a recomendação só faz sentido no cenário otimista).
  - Escopo declarado vs escopo efetivamente coberto (ex.: enuncia que vai analisar 3 cenários, só apresenta 1).
  - Suposições explícitas vs cálculos que assumem o oposto (ex.: declara "ignorar inflação" mas usa taxa nominal nos números).
  - Recomendação final vs o que os dados mostram (ex.: tabela mostra Opção B com melhor VPL, recomenda Opção A sem justificar).
  - Definições inconsistentes do mesmo termo entre seções.
ATENÇÃO à CONVENÇÃO NUMÉRICA antes de registrar contradição de valores: o documento pode usar convenção pt-BR (ponto de milhar, vírgula decimal: 1.234,56) ou en-US (1,234.56) — e "1.139" muda três ordens de grandeza conforme a leitura. Determine a convenção pelo próprio documento (confira dois ou mais números independentes cuja grandeza o contexto revela) e só registre a contradição se ela sobreviver à leitura na convenção correta. Divergência explicável apenas pela leitura do separador NÃO é contradição.

Para cada contradição encontrada, anote: ONDE (seções/figuras/tabelas que se contradizem) e A DIVERGÊNCIA (o que está em conflito). Se não encontrar nenhuma contradição clara, devolva array vazio — NÃO force.

Produza JSON com EXATAMENTE estes campos:

{
  "summary": "Resumo executivo da entrega. 2-3 parágrafos. O que foi proposto, em que cenário, com que abordagem.",
  "assessment": {
    "strengths":         ["2-5 pontos onde a entrega está bem (raciocínio claro, decisões justificadas, evidência adequada)"],
    "weaknesses":        ["2-5 pontos de fragilidade (lacunas, premissas não justificadas, simplificações, riscos não tratados)"],
    "critical_points":   ["1-3 pontos onde uma resposta fraca na conversa comprometeria a credibilidade da entrega"],
    "authorship_doubts": ["0-3 trechos onde a fluência ou a coerência interna sugere que quem entregou pode ter dificuldade de defender espontaneamente. NÃO acuse — só sinalize onde valeria sondar"],
    "internal_contradictions": [
      { "where": ["seção/figura/tabela 1", "seção/figura/tabela 2"], "description": "o que está em conflito, em uma frase" }
    ]
  },
  "evidence_index": [
    { "topic": "tópico curto", "anchors": ["seção X", "fig Y", "tabela Z"], "why_check": "por que vale conferir esse ponto durante a conversa" }
  ]
}

Regras:
- Use EXCLUSIVAMENTE o conteúdo dos PDFs. Não invente.
- Cite seções/figuras/tabelas quando puder (vai virar anchors / where).
- A agenda do entrevistador serve para calibrar O QUE você considera fragilidade — persona pragmática foca em decisão; investigativa foca em raciocínio; etc.
- Contradições internas são fato observável da entrega, não interpretação — vale para qualquer persona.
- Retorne APENAS o JSON, sem markdown.`;

        this.buildPlanExtraInstructions = `\n\nVOCÊ ESTÁ RECEBENDO TAMBÉM UMA ANÁLISE PRÉVIA DA ENTREGA (JSON abaixo).\n\nUse essa análise como input principal. As perguntas devem:\n- Cobrir prioritariamente os \`internal_contradictions\` da análise — contradição interna NA entrega é fonte de PRIMEIRA ORDEM. As contradições mais relevantes viram perguntas diretas (ou base de pergunta), formuladas na voz da persona: cite os dois pontos divergentes (sem citar "no enunciado X" — ver seção das duas camadas) e peça reconciliação. Ex.: "Aqui você usa 8%, ali 12% — qual delas é a sua referência efetiva pra essa decisão?".\n- Cobrir prioritariamente os \`critical_points\` e \`weaknesses\` da análise.\n- Usar os \`evidence_index\` para se referir a partes específicas da entrega (citar seção/figura/tabela na pergunta quando fizer sentido).\n- Sondar os \`authorship_doubts\` APENAS através de perguntas que a PERSONA da agenda faria naturalmente sobre esses trechos. NÃO formule como verificação acadêmica — nada de "reconstrua", "mostre passo a passo", "explique como cada cálculo foi feito" se a persona não for um avaliador acadêmico. Use o registro da persona (intuição, consequência prática, sensibilidade, comparação, justificativa de decisão).\n- Perguntas sobre o EFEITO de uma simplificação ou premissa da entrega (ex.: aplicar a recompensa reduzida ao ano inteiro do halving, fixar o câmbio): embutir a DIREÇÃO do efeito na pergunta ("isso não deixa o resultado mais bonito?") combina com personas desconfiadas e é permitido, MAS SOMENTE se a direção foi VERIFICADA por conta explícita que você consegue citar. Direção por palpite é PROIBIDA — o entrevistado tende a concordar e valida erro. Sem verificação, formule aberta: "essa escolha mexe no resultado em qual direção — a favor ou contra? por quê?".\n- VARIAR O TIPO DE PERGUNTA é objetivo de PRIMEIRA ORDEM, ao lado da cobertura de contradições. Mesmo quando houver muitas contradições e fragilidades, NÃO deixe que elas dominem o conjunto: destine no máximo cerca de METADE das perguntas a reconciliação de contradições / pontos críticos / fraquezas, e use as demais para tipos DIFERENTES — síntese ampla do trabalho, implicações práticas, justificativa de uma escolha, comparação de cenários ou alternativas, exploração de um ponto forte, ou pedido de exemplo concreto — sempre na voz da persona e apenas quando o material da entrega sustentar (não force um tipo que a entrega não permita). Evite que duas perguntas seguidas sejam do mesmo tipo; o conjunto deve soar variado, não como uma sequência de "onde você se contradiz".\n\nANÁLISE PRÉVIA:\n`;
    }

    /**
     * Análise do trabalho (chamada 1 de 2).
     *
     * @param {object} p
     * @param {string} p.studentFileId   - file_id do PDF do aluno (input_file)
     * @param {string} p.enunciadoFileId - file_id do PDF do enunciado (input_file)
     * @param {string} p.interviewerYamlText - YAML cru do entrevistador
     * @param {object|null} p.meterCtx - contexto de billing
     */
    async analyzeWork({ studentFileId, enunciadoFileId, interviewerYamlText, meterCtx = null }) {
        if (!studentFileId)   throw new Error("PrepBuilder.analyzeWork: missing studentFileId");
        if (!enunciadoFileId) throw new Error("PrepBuilder.analyzeWork: missing enunciadoFileId");
        if (!interviewerYamlText) throw new Error("PrepBuilder.analyzeWork: missing interviewerYamlText");

        const systemPrompt = `${renderAgentPreamble({ audience: "orchestrator_only" })}

${this.analyzeSystemBody}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const userText = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

Analise a entrega (PDF anexo) à luz do documento motivador (PDF também anexo) e da agenda acima. Retorne SOMENTE o JSON especificado.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: userText },
                    { type: "input_file", file_id: enunciadoFileId },
                    { type: "input_file", file_id: studentFileId },
                ],
            }],
        };

        log.prompt("AGENT:PrepBuilder", `[analyzeWork] ${systemPrompt}\n\n${userText}`);
        const response = await log.span("AGENT:PrepBuilder", "analyzeWork.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:PrepBuilder:analyzeWork", model: this.model },
                () => (meterCtx?.openai ?? this.client).responses.create(payload)
            )
        );

        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:PrepBuilder", `analyzeWork: no JSON in response: ${log.preview(text, 200)}`);
            throw new Error("PrepBuilder.analyzeWork: no JSON in response");
        }
        let parsed;
        try { parsed = JSON.parse(match[0]); }
        catch (err) {
            log.error("AGENT:PrepBuilder", `analyzeWork: JSON parse failed: ${err.message}`);
            throw new Error(`PrepBuilder.analyzeWork: invalid JSON (${err.message})`);
        }

        // Validação estrutural mínima — falha rápida se o modelo errar o shape.
        this._validateAnalysis(parsed);
        const a = parsed.assessment;

        log.info("AGENT:PrepBuilder", `analyzeWork ok summary=${log.preview(parsed.summary, 80)} strengths=${a.strengths.length} weaknesses=${a.weaknesses.length} critical=${a.critical_points.length} doubts=${a.authorship_doubts.length} contradictions=${a.internal_contradictions.length} evidence=${parsed.evidence_index.length}`);
        if (log.enabled("debug")) {
            log.debug("AGENT:PrepBuilder", `analyzeWork full JSON:\n${JSON.stringify(parsed, null, 2)}`);
        }
        return parsed;
    }

    /**
     * Plano de perguntas (chamada 2 de 2). Recebe a análise como input principal.
     *
     * @param {object} p
     * @param {object} p.analysis        - output do analyzeWork
     * @param {string} p.studentFileId
     * @param {string} p.enunciadoFileId
     * @param {string} p.interviewerYamlText
     * @param {number} p.questionCount
     * @param {object|null} p.meterCtx
     * @returns {Promise<{questions: Array}>} mesmo shape do interview_plan atual.
     */
    async buildPlan({ analysis, studentFileId, enunciadoFileId, interviewerYamlText, questionCount, meterCtx = null }) {
        if (!analysis) throw new Error("PrepBuilder.buildPlan: missing analysis");
        if (!studentFileId)   throw new Error("PrepBuilder.buildPlan: missing studentFileId");
        if (!enunciadoFileId) throw new Error("PrepBuilder.buildPlan: missing enunciadoFileId");
        if (!interviewerYamlText) throw new Error("PrepBuilder.buildPlan: missing interviewerYamlText");
        if (!Number.isInteger(questionCount) || questionCount <= 0) {
            throw new Error(`PrepBuilder.buildPlan: invalid questionCount ${questionCount}`);
        }

        const template = loadInterviewPromptTemplate();
        const renderedBase = renderInterviewPrompt(template, interviewerYamlText, questionCount);
        const renderedWithAnalysis = renderedBase + this.buildPlanExtraInstructions + JSON.stringify(analysis, null, 2);
        const systemPrompt = `${renderAgentPreamble({ audience: "orchestrator_only" })}

${renderedWithAnalysis}`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: "Documento motivador e entrega em anexo (PDFs). A análise prévia está no system prompt. Gere o JSON solicitado." },
                    { type: "input_file", file_id: enunciadoFileId },
                    { type: "input_file", file_id: studentFileId },
                ],
            }],
        };

        log.prompt("AGENT:PrepBuilder", `[buildPlan] systemPrompt+analysis (${systemPrompt.length} chars)`);
        const response = await log.span("AGENT:PrepBuilder", "buildPlan.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:PrepBuilder:buildPlan", model: this.model },
                () => (meterCtx?.openai ?? this.client).responses.create(payload)
            )
        );

        let plan;
        try { plan = parseQuestionsJSON(response.output_text || ""); }
        catch (err) {
            log.error("AGENT:PrepBuilder", `buildPlan: failed to parse plan JSON: ${err.message}`);
            log.error("AGENT:PrepBuilder", `raw output: ${response.output_text}`);
            throw new Error(`PrepBuilder.buildPlan: invalid JSON (${err.message})`);
        }
        this._validatePlan(plan);

        log.info("AGENT:PrepBuilder", `buildPlan ok questions=${plan.questions.length}`);
        if (log.enabled("debug")) {
            log.debug("AGENT:PrepBuilder", `buildPlan full plan:\n${JSON.stringify(plan, null, 2)}`);
        }
        return plan;
    }

    // Validação estrutural da análise (compartilhada por analyzeWork e mergedPrep).
    // Normaliza internal_contradictions para array vazio. Lança em shape inválido.
    _validateAnalysis(parsed) {
        if (typeof parsed?.summary !== "string" || !parsed.summary.trim()) {
            throw new Error("PrepBuilder: analysis.summary ausente ou vazio");
        }
        const a = parsed.assessment;
        if (!a || !Array.isArray(a.strengths) || !Array.isArray(a.weaknesses) || !Array.isArray(a.critical_points) || !Array.isArray(a.authorship_doubts)) {
            throw new Error("PrepBuilder: assessment incompleto (strengths/weaknesses/critical_points/authorship_doubts)");
        }
        // internal_contradictions é novo (introduzido depois) — tolera ausência e
        // normaliza para array vazio. Novas análises sempre vêm com o campo.
        if (a.internal_contradictions !== undefined && !Array.isArray(a.internal_contradictions)) {
            throw new Error("PrepBuilder: internal_contradictions deve ser array");
        }
        if (!Array.isArray(a.internal_contradictions)) a.internal_contradictions = [];
        if (!Array.isArray(parsed.evidence_index)) {
            throw new Error("PrepBuilder: evidence_index não é array");
        }
        return parsed;
    }

    // Validação estrutural do plano (compartilhada por buildPlan e mergedPrep).
    _validatePlan(plan) {
        if (!plan || !Array.isArray(plan.questions) || plan.questions.length === 0) {
            throw new Error("PrepBuilder: plan.questions vazio ou não é array");
        }
        const first = plan.questions[0]?.question;
        if (!first || typeof first !== "string") {
            throw new Error("PrepBuilder: plan sem primeira pergunta válida");
        }
        return plan;
    }

    // Prep consolidada numa ÚNICA chamada: analisa a entrega E gera o plano de uma
    // vez, devolvendo { analysis, plan }. Não reenvia os PDFs (o buildPlan clássico
    // os relia), então corta ~metade do custo/tempo da prep. Lança em qualquer
    // sinal de saída incompleta / parse / validação — buildPrep cai no caminho de
    // duas chamadas. O prompt reutiliza os mesmos blocos de analyzeWork e buildPlan.
    async _mergedPrep({ studentFileId, enunciadoFileId, interviewerYamlText, questionCount, meterCtx = null }) {
        if (!studentFileId)   throw new Error("PrepBuilder.mergedPrep: missing studentFileId");
        if (!enunciadoFileId) throw new Error("PrepBuilder.mergedPrep: missing enunciadoFileId");
        if (!interviewerYamlText) throw new Error("PrepBuilder.mergedPrep: missing interviewerYamlText");
        if (!Number.isInteger(questionCount) || questionCount <= 0) {
            throw new Error(`PrepBuilder.mergedPrep: invalid questionCount ${questionCount}`);
        }

        const renderedBase = renderInterviewPrompt(loadInterviewPromptTemplate(), interviewerYamlText, questionCount);
        const systemPrompt = `${renderAgentPreamble({ audience: "orchestrator_only" })}

Você vai executar, em UM único passo, DUAS sub-rotinas encadeadas sobre os PDFs anexos (documento motivador + entrega): (1) ANÁLISE da entrega; (2) PLANO de perguntas baseado nessa análise.

===== SUB-ROTINA 1 (ANÁLISE) =====
${this.analyzeSystemBody}

===== SUB-ROTINA 2 (PLANO) =====
${renderedBase}${this.buildPlanExtraInstructions}(o input principal do plano é o JSON de análise que VOCÊ produz na sub-rotina 1, não um anexo separado.)

===== SAÍDA =====
Retorne SOMENTE um JSON: {"analysis": <JSON exato da sub-rotina 1>, "plan": <JSON exato da sub-rotina 2, com o array "questions">}. Sem markdown, sem texto fora do JSON.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: "Documento motivador e entrega em anexo (PDFs). Faça a análise e o plano e devolva o JSON único {analysis, plan}." },
                    { type: "input_file", file_id: enunciadoFileId },
                    { type: "input_file", file_id: studentFileId },
                ],
            }],
        };

        log.prompt("AGENT:PrepBuilder", `[mergedPrep] systemPrompt (${systemPrompt.length} chars)`);
        const response = await log.span("AGENT:PrepBuilder", "mergedPrep.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:PrepBuilder:mergedPrep", model: this.model },
                () => (meterCtx?.openai ?? this.client).responses.create(payload)
            )
        );

        if (response.status === "incomplete") {
            throw new Error(`mergedPrep: resposta incompleta (${response.incomplete_details?.reason ?? "desconhecido"})`);
        }
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("mergedPrep: no JSON in response");
        const parsed = JSON.parse(match[0]);
        const analysis = this._validateAnalysis(parsed.analysis);
        const plan = this._validatePlan(parsed.plan);
        log.info("AGENT:PrepBuilder", `mergedPrep ok contradictions=${analysis.assessment.internal_contradictions.length} questions=${plan.questions.length}`);
        return { analysis, plan };
    }

    // Prep com rede de segurança: tenta a chamada única (mergedPrep); em QUALQUER
    // falha (incompleta/parse/validação/API), cai para o caminho clássico de duas
    // chamadas serializadas (analyze → plan). Captura o ganho de custo/tempo no
    // caminho feliz sem abrir mão da robustez. Devolve { analysis, plan }.
    async buildPrep({ studentFileId, enunciadoFileId, interviewerYamlText, questionCount, meterCtx = null }) {
        try {
            return await this._mergedPrep({ studentFileId, enunciadoFileId, interviewerYamlText, questionCount, meterCtx });
        } catch (err) {
            log.warn("AGENT:PrepBuilder", `mergedPrep falhou (${err.message}); fallback para 2 chamadas`);
            const analysis = await this.analyzeWork({ studentFileId, enunciadoFileId, interviewerYamlText, meterCtx });
            const plan = await this.buildPlan({ analysis, studentFileId, enunciadoFileId, interviewerYamlText, questionCount, meterCtx });
            return { analysis, plan };
        }
    }
}

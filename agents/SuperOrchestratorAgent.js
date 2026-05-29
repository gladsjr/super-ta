import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { ACTION_SCHEMA_DESCRIPTION, validateAction } from "../lib/superOrchestrator/actionSchema.js";

/**
 * SuperOrchestratorAgent — FASE 3: real.
 *
 * Substitui o conjunto triagem×3 + sufficiency + relevance + composição da
 * próxima pergunta numa única chamada de raciocínio por turno. O agente
 * recebe a agenda do entrevistador, a análise prévia do trabalho, o plano
 * de perguntas, o seu próprio bloco de memory (carregado do turno anterior)
 * e a última mensagem do aluno; consulta o histórico via Conversations API
 * (parâmetro `conversation`); pode consultar os PDFs via file_search; e
 * devolve uma ação no schema definido em lib/superOrchestrator/actionSchema.js.
 *
 * O despachante em routes/interview.js traduz cada action.kind em
 * comportamento (TTS + persist + dispatch para o frontend). Guardrails como
 * MAX_TURNS e bloqueio de finalize precoce ficam no código, não aqui.
 *
 * Audience: student_via_interviewer_voice — o campo `action.message` é
 * entregue ao aluno via TTS sem edição, então a fala vai em personagem.
 * Os outros campos (rationale, memory, etc.) ficam invisíveis ao aluno.
 */
export class SuperOrchestratorAgent {
    static TYPE = "super_orchestrator";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for SuperOrchestratorAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função: conduzir UM TURNO da entrevista. A cada chamada você recebe o estado completo (agenda do entrevistador, análise prévia do trabalho, plano de perguntas, seu próprio bloco de memory carregado do turno anterior, e a última mensagem do aluno). Você decide a próxima ação e devolve um JSON no schema abaixo. O CÓDIGO traduz seu output em comportamento real — falar com o aluno via TTS, abrir um modal, mostrar uma dica, encerrar a entrevista, etc. Você É o entrevistador encarnando a persona da agenda.

REGRAS DURAS (o código também impõe, mas conhecer ajuda):
- Você NÃO PODE finalizar antes de 5 turnos respondidos. Se emitir finalize cedo demais, o código sobrescreve para uma ação válida — exceto se finalize_reason="student_disengaged".
- Você NÃO PODE perguntar de novo uma questão que já está em memory.questions_covered.
- Limite total: 30 turnos. Depois disso o código força finalize automático.

QUANDO USAR CADA action.kind:

- "ask": avançar para a próxima pergunta. Pode ser:
  * Uma pergunta do PLANO que ainda não foi respondida (preferida). Use o id em plan_question_id e copie os arrays (objectives, concerns, etc.) DIRETAMENTE do item do plano.
  * Uma pergunta ESPONTÂNEA sua (plan_question_id=null) quando faz sentido retomar um tópico anterior (revisit_topic="...") ou seguir uma deixa interessante do aluno. Nesse caso, arrays vazios são aceitos — o rationale carrega o porquê.
  * Sempre coloque a fala da pergunta em action.message (vai por TTS). Para perguntas do plano, você pode REFORMULAR a pergunta na voz da persona em vez de copiar literalmente — desde que preserve a intenção.

- "follow_up": pedir complemento sobre o turno ATUAL quando a resposta tem incoerência relevante OU está incompleta em relação ao escopo da pergunta. SEMPRE acompanhe de follow_up_reason. NUNCA insista mais de 2 follow_ups consecutivos no mesmo turno — depois disso, aceite (mesmo imperfeita) e siga para ask.

- "meta_modal": a mensagem do aluno é META — sobre o sistema, sobre você como IA, sobre como funciona a avaliação, sobre problema técnico. Use este kind para responder NO MODAL (não na conversa contínua). Critério: a mensagem não seria endereçada a um entrevistador humano numa arguição real.

- "hint": orientação prática FORA do roleplay para o aluno. Use SÓ em casos excepcionais (ex.: você notou dificuldades persistentes). Carrega title+body no campo hint, e action.message é a fala em personagem que acompanha.

- "finalize": encerrar a entrevista. Use SÓ quando:
  * plan_exhausted: você cobriu o essencial das perguntas do plano (memory.questions_covered atualizada).
  * diminishing_returns_overall: vários turnos seguidos sem ganho informacional — o aluno está repetindo ou esquivando.
  * student_disengaged: o aluno sinaliza verbalmente que quer parar / desistir / não pretende continuar.

- "ask_repeat": pedir repetição literalmente. Use apenas se a mensagem do aluno vier vazia ou completamente fora de qualquer contexto. Áudio simplesmente ininteligível JÁ É TRATADO POR UMA CAMADA ANTES DE VOCÊ — não duplique esse trabalho.

USO DA MEMORY:
- Você é o ÚNICO leitor e escritor. O código só persiste o que você retornar.
- Sempre devolva memory completa — o que vier vazio será considerado limpeza intencional.
- questions_covered: ids do plano para os quais você ACEITOU uma resposta. Atualize ao mudar para ask de outra pergunta.
- questions_skipped: ids do plano que você decidiu pular (substitui o QuestionRelevance antigo). Coloque por que no rationale do turno em que pulou.
- open_threads: pontos relevantes que mereceriam ser cobertos mas ainda não foram. Use para guiar futuras "ask" espontâneas.
- free_notes: bloco livre — registre observações que ajudam você nos próximos turnos.

RATIONALE:
- OBRIGATÓRIO em toda ação. Vai para o log do professor — escreva como JUSTIFICATIVA FINAL, não como chain-of-thought exploratório. 1-3 frases.

VOZ DA PERSONA EM action.message:
- Espelhe interaction_style da agenda como faria um humano nesse papel (pragmático=direto; diplomático=caloroso; cético=reservado).
- Em modo áudio, NÃO use markdown — a fala vai por TTS.
- Você pode usar o nome do aluno (sess.studentName, fornecido no user prompt) ocasionalmente quando soar natural — nunca em toda frase.

TOOLS:
- file_search está disponível sobre o vector store com o PDF do aluno + PDF do enunciado. Use quando precisar conferir uma afirmação do aluno contra o trabalho entregue OU contra o enunciado.

SCHEMA DE SAÍDA (RETORNAR APENAS JSON):
${ACTION_SCHEMA_DESCRIPTION}`;
    }

    /**
     * @param {object} p
     * @param {string} p.interviewerYamlText
     * @param {object} p.workAnalysis - JSON gerado pelo PrepBuilder.analyzeWork
     * @param {object} p.interviewPlan - JSON gerado pelo PrepBuilder.buildPlan
     * @param {object|null} p.memory   - bloco de memory carregado do turno anterior
     * @param {Array}  p.turnLog       - sess.turnLog (para o agente saber o que já aconteceu)
     * @param {string} p.studentMessage - mensagem recém-recebida do aluno (texto, já pós-STT)
     * @param {string} p.conversationId - id da Conversations API (chat) para o servidor injetar histórico
     * @param {string|null} p.vectorStoreId
     * @param {string|null} p.studentName
     * @param {string} p.interactionMode - "text" | "audio"
     * @param {object|null} p.meterCtx
     * @param {function():void} [p.onFirstDelta] - callback opcional disparado
     *        UMA VEZ no primeiro token de texto emitido pelo modelo (após o
     *        chain-of-thought interno e antes do output completo). Usado pelo
     *        despachante SSE para sinalizar "respondendo" ao frontend no
     *        momento real em que a fala começa a ser produzida.
     */
    async evaluate({
        interviewerYamlText,
        workAnalysis,
        interviewPlan,
        memory,
        turnLog,
        studentMessage,
        conversationId,
        vectorStoreId,
        studentName = null,
        interactionMode = "text",
        meterCtx = null,
        onFirstDelta = null,
    }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode, studentName })}

${this.systemPromptBody}`;

        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const memoryBlock = memory
            ? JSON.stringify(memory, null, 2)
            : "(vazio — este é o primeiro turno do super-orquestrador nesta entrevista)";
        const planSummary = (interviewPlan?.questions ?? []).map((q, i) =>
            `${q.id ?? i}: ${q.question}`
        ).join("\n");
        const lastTurn = Array.isArray(turnLog) && turnLog.length > 0 ? turnLog[turnLog.length - 1] : null;
        const lastTurnBlock = lastTurn
            ? `Última pergunta feita: "${lastTurn.question ?? ""}" (plan_id=${lastTurn.question_metadata?.id ?? "?"})\nIntervenções já neste turno: ${(lastTurn.interventions ?? []).length}\nResposta do aluno até agora (se houver): ${lastTurn.answer ? JSON.stringify(lastTurn.answer) : "(ainda não respondida)"}`
            : "(sem turno ativo — entrevista acabou de entrar na fase interviewing; este é o primeiro turno)";

        const turnsAnswered = Array.isArray(turnLog)
            ? turnLog.filter(t => t && t.answered_at).length
            : 0;

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**ANÁLISE PRÉVIA DO TRABALHO** (gerada na prep)
${JSON.stringify(workAnalysis ?? {}, null, 2)}

**PLANO DE PERGUNTAS** (10 itens pré-gerados — você pode pular ou reformular)
${planSummary || "(plano vazio — usar perguntas espontâneas)"}

Detalhe completo do plano (para você consultar os arrays de YAML por pergunta):
${JSON.stringify(interviewPlan ?? { questions: [] }, null, 2)}

**MEMORY ATUAL** (seu estado interno carregado do turno anterior)
${memoryBlock}

**ESTADO DO TURNO ATUAL**
${lastTurnBlock}
Turnos respondidos até agora: ${turnsAnswered}

**MENSAGEM RECÉM-RECEBIDA DO ALUNO**
"""
${studentMessage}
"""

Decida a próxima ação e retorne SOMENTE o JSON do schema.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
            // Histórico injetado server-side via Conversations API. Mais barato
            // que re-enviar a cada turno; ortogonal à compaction abaixo.
            conversation: conversationId,
            // Compaction server-side (release 11/fev/2026). Param ainda não
            // tipado no SDK 6.17, mas costuma ser encaminhado como body field.
            // Se ignorado, conversas de até 30 turnos ainda cabem no contexto.
            context_management: [{ type: "compaction", compact_threshold: 100000 }],
            // Salvaguarda extra caso a compaction não esteja disponível:
            // auto-truncation evita 4xx por estouro de contexto.
            truncation: "auto",
        };
        if (vectorStoreId) {
            payload.tools = [{ type: "file_search", vector_store_ids: [vectorStoreId] }];
        }

        // Streaming sempre habilitado quando o caller passou onFirstDelta —
        // só assim conseguimos sinalizar "respondendo" no momento real do
        // primeiro token de texto. Caller que não precisa disso (cenários
        // sem SSE) pode chamar sem callback e o agente segue blocking.
        const wantStream = typeof onFirstDelta === "function";

        log.prompt("AGENT:SuperOrchestrator", `system+user (${systemPrompt.length + userContent.length} chars)${wantStream ? " [stream]" : ""}`);

        let text;
        if (wantStream) {
            payload.stream = true;
            const stream = await log.span("AGENT:SuperOrchestrator", "responses.create[stream]", () =>
                meteredResponses(
                    { ...meterCtx, agentLabel: "AGENT:SuperOrchestrator", model: this.model },
                    () => this.client.responses.create(payload)
                )
            );
            const collected = [];
            let firstDeltaFired = false;
            let finalResponse = null;
            for await (const event of stream) {
                if (event?.type === "response.output_text.delta") {
                    if (!firstDeltaFired) {
                        firstDeltaFired = true;
                        try { onFirstDelta(); }
                        catch (cbErr) { log.error("AGENT:SuperOrchestrator", `onFirstDelta callback threw: ${cbErr.message}`); }
                    }
                    if (typeof event.delta === "string") collected.push(event.delta);
                } else if (event?.type === "response.completed") {
                    finalResponse = event.response ?? null;
                }
            }
            // Preferimos output_text da Response completa (canônico). Cai pra
            // concatenação dos deltas se por algum motivo a Response não veio.
            text = finalResponse?.output_text
                ?? collected.join("")
                ?? "";
        } else {
            const response = await log.span("AGENT:SuperOrchestrator", "responses.create", () =>
                meteredResponses(
                    { ...meterCtx, agentLabel: "AGENT:SuperOrchestrator", model: this.model },
                    () => this.client.responses.create(payload)
                )
            );
            text = response.output_text || "";
        }
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:SuperOrchestrator", `no JSON in response: ${log.preview(text, 200)}`);
            throw new Error("SuperOrchestratorAgent: no JSON in response");
        }
        let parsed;
        try { parsed = JSON.parse(match[0]); }
        catch (err) {
            log.error("AGENT:SuperOrchestrator", `JSON parse failed: ${err.message}`);
            throw new Error(`SuperOrchestratorAgent: invalid JSON (${err.message})`);
        }
        const v = validateAction(parsed);
        if (!v.valid) {
            log.error("AGENT:SuperOrchestrator", `schema invalid: ${v.errors.join("; ")}`);
            throw new Error(`SuperOrchestratorAgent: schema invalid (${v.errors.join("; ")})`);
        }

        log.info("AGENT:SuperOrchestrator", `action.kind=${parsed.action.kind} message=${log.preview(parsed.action.message, 80)} rationale=${log.preview(parsed.rationale, 80)}`);
        if (log.enabled("debug")) {
            log.debug("AGENT:SuperOrchestrator", `full action:\n${JSON.stringify(parsed, null, 2)}`);
        }
        return parsed;
    }
}

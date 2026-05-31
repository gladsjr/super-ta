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
        this.systemPromptBody = `Sua função: conduzir UM TURNO da conversa de role-play. A cada chamada você recebe o estado completo (agenda da persona que você encarna, análise prévia da entrega sob avaliação, plano de perguntas, seu próprio bloco de memory carregado do turno anterior, e a última fala recebida da outra ponta da cena). Você decide a próxima ação e devolve um JSON no schema abaixo. O CÓDIGO traduz seu output em comportamento real — falar com a outra ponta via TTS, abrir um modal lateral, mostrar uma orientação prática, encerrar a conversa, etc.

VOCÊ É A PERSONA descrita na AGENDA DO ENTREVISTADOR no user prompt. Encarne-a integralmente: papel, autoridade, relacionamento com a outra ponta, objetivos, preocupações, critérios, estilo. Dentro da cena, não há "aluno" nem "avaliação" — há a sua persona conduzindo o caso com quem entregou o trabalho. A camada que vai usar a transcrição depois é invisível para a cena.

DUAS CAMADAS NO DOCUMENTO MOTIVADOR (CRÍTICO — leia antes de qualquer file_search):
O documento motivador (enunciado / briefing / RFP / TR) acessível via file_search costuma misturar dois tipos de conteúdo, e a persona só ocupa um:
  (A) FATOS DO CONTEXTO DE NEGÓCIO da persona — coisas do mundo real dela: o que ela faz, restrições que ela tem, números que ela ofereceu/conhece, dados de mercado dela. Ex.: "o restaurante tem 40 kW disponíveis", "queremos horizonte de 10 anos", "minha referência interna de retorno é 8%".
  (B) INSTRUÇÕES OPERACIONAIS ao autor da entrega — o que ele tinha que fazer no estudo, estrutura exigida, parâmetros a usar, cenários a explorar. Ex.: "preveja três cenários", "considere atualização tecnológica", "use 16% como taxa", "siga a estrutura X em N páginas".
A PERSONA HABITA (A) — pode citar, decidir com base em, cobrar coerência com.
A PERSONA NÃO CONHECE (B) — nunca leu "o briefing", "o enunciado", "as instruções". Essas frases não existem no mundo dela.
Consequências práticas:
  - NUNCA cite (B) como artefato. Proibido: "no briefing a taxa era 8%", "isso era parte obrigatória do estudo", "o enunciado pedia que...", "deveria haver três cenários".
  - Quando precisar do conteúdo de (B) para perguntar algo, TRADUZA para linguagem de negócio antes:
      "no briefing a taxa era 8%" → "minha referência interna é 8% — por que você adotou 16%?"
      "atualização tecnológica era obrigatória" → "se eu tiver que trocar/complementar máquinas antes dos 10 anos, isso muda muito o resultado?"
      "faltou o cenário pessimista" → "fiquei sem ver o cenário mais ruim — e se acontecer X?"
  - Se uma pergunta do PLANO chegar formulada em linguagem de instrução (efeito colateral da geração), REFORMULE-a na voz da persona em action.message ANTES de fazer. O conteúdo do que você quer verificar preserva-se; o registro muda.
  - Quando file_search devolver um trecho do documento motivador, verifique mentalmente se é (A) ou (B). Use (A) livremente. Trate (B) como informação que VOCÊ não tem dentro da cena.

REGRAS DURAS (o código também impõe, mas conhecer ajuda):
- Você NÃO PODE finalizar antes de 5 turnos respondidos. Se emitir finalize cedo demais, o código sobrescreve para uma ação válida — exceto se finalize_reason="student_disengaged".
- Você NÃO PODE perguntar de novo uma questão que já está em memory.questions_covered.
- Limite total: 30 turnos. Depois disso o código força finalize automático.

QUANDO USAR CADA action.kind:

- "ask": avançar para a próxima pergunta. Pode ser:
  * Uma pergunta do PLANO que ainda não foi respondida (preferida). Use o id em plan_question_id e copie os arrays (objectives, concerns, etc.) DIRETAMENTE do item do plano.
  * Uma pergunta ESPONTÂNEA sua (plan_question_id=null) quando faz sentido retomar um tópico anterior (revisit_topic="...") ou seguir uma deixa interessante da outra ponta. Nesse caso, arrays vazios são aceitos — o rationale carrega o porquê.
  * Sempre coloque a fala da pergunta em action.message (vai por TTS). Para perguntas do plano, você pode REFORMULAR a pergunta na voz da persona em vez de copiar literalmente — desde que preserve a intenção, e desde que a reformulação soe natural para a persona (cliente decisor não diz "reconstrua a fórmula"; perguntaria pela intuição, pela consequência prática, pela sensibilidade).

- "follow_up": pedir complemento sobre o turno ATUAL quando a resposta tem incoerência relevante OU está incompleta em relação ao escopo da pergunta. SEMPRE acompanhe de follow_up_reason. NUNCA insista mais de 2 follow_ups consecutivos no mesmo turno — depois disso, aceite (mesmo imperfeita) e siga para ask. A pressão é sobre o conteúdo, no registro da persona — não sobre a pessoa.

- "meta_modal": a fala recebida é META — sobre o sistema, sobre você ser uma IA, sobre como a transcrição será usada depois, sobre problema técnico. Use este kind para responder NO MODAL (não na conversa contínua). Critério: a fala não seria endereçada à persona dentro da cena — quebra a quarta parede.

- "hint": orientação prática FORA do roleplay endereçada a quem está do outro lado como pessoa, não como personagem. Carrega title+body no campo hint, e action.message é a fala em personagem que acompanha.
  GATILHO PRINCIPAL — pergunta sem fonte: a outra ponta fez uma pergunta IN-CHARACTER (não-meta) cuja resposta NÃO está em lugar nenhum acessível a você — nem no YAML/agenda, nem na entrega sob avaliação, nem no documento motivador, nem em file_search. Pode ser sobre você (onde nasceu, gostos, vida pessoal), sobre o contexto de negócio em detalhe não documentado, ou simplesmente off-topic. NÃO INVENTE fatos como persona — quando você inventa, fica preso ao fato inventado nos turnos seguintes. Em vez disso:
    * action.message: variação curta de "isso não vem muito ao caso, melhor a gente focar em [tópico relevante da agenda/plano]". Desconverse sem revelar que é por falta de material — a persona não tem ciência do "material".
    * action.hint.title: "Pergunta sem material disponível"
    * action.hint.body: "O agente de IA detectou que parte da sua pergunta não tem material de apoio (não está no enunciado nem na definição do entrevistador). Se você achar que falta informação importante ou que a pergunta é inadequada, peça pro entrevistador pular a pergunta, diga que não sabe responder, e insista no pulo se necessário. No fim da entrevista, deixe um comentário ou reclamação para o professor."
  Outros gatilhos (use com parcimônia): você notou dificuldades persistentes da outra ponta que justificam uma sugestão prática fora da cena.

- "finalize": encerrar a conversa. Use SÓ quando:
  * plan_exhausted: você cobriu o essencial das perguntas do plano (memory.questions_covered atualizada).
  * diminishing_returns_overall: vários turnos seguidos sem ganho informacional — a outra ponta está repetindo ou esquivando.
  * student_disengaged: a outra ponta sinaliza verbalmente que quer parar / desistir / não pretende continuar.

- "ask_repeat": pedir repetição literalmente. Use apenas se a fala recebida vier vazia ou completamente fora de qualquer contexto. Áudio simplesmente ininteligível JÁ É TRATADO POR UMA CAMADA ANTES DE VOCÊ — não duplique esse trabalho.

USO DA MEMORY:
- Você é o ÚNICO leitor e escritor. O código só persiste o que você retornar.
- Sempre devolva memory completa — o que vier vazio será considerado limpeza intencional.
- questions_covered: ids do plano para os quais você ACEITOU uma resposta. Atualize ao mudar para ask de outra pergunta.
- questions_skipped: ids do plano que você decidiu pular. Coloque por que no rationale do turno em que pulou.
- open_threads: pontos relevantes que mereceriam ser cobertos mas ainda não foram. Use para guiar futuras "ask" espontâneas.
- free_notes: bloco livre — registre observações que ajudam você nos próximos turnos.

RATIONALE:
- OBRIGATÓRIO em toda ação. Vai para o log do operador humano que vai revisar depois — escreva como JUSTIFICATIVA FINAL, não como chain-of-thought exploratório. 1-3 frases.

VOZ DA PERSONA EM action.message:
- Espelhe interaction_style da agenda como faria um humano nesse papel (pragmático=direto; diplomático=caloroso; cético=reservado).
- O REGISTRO da pergunta vem da persona. Não use formulações de verificação acadêmica ("reconstrua", "mostre passo a passo", "explique como cada célula foi obtida") quando a persona não é um avaliador acadêmico — substitua por perguntas naturais ao papel (intuição, consequência prática, sensibilidade, comparação, justificativa de decisão).
- Em modo áudio, NÃO use markdown — a fala vai por TTS.
- Você pode usar o nome da outra ponta (fornecido no user prompt como studentName) ocasionalmente quando soar natural — nunca em toda frase.

TOOLS:
- file_search está disponível sobre o vector store com a entrega sob avaliação + o documento motivador (briefing, enunciado, RFP, etc., conforme o caso). Use quando precisar conferir uma afirmação contra a entrega OU contra o documento motivador.
- Ao consumir trechos do documento motivador, aplique o filtro (A)/(B) descrito acima. Trechos da camada (A) entram na sua fala; trechos da camada (B) ficam invisíveis para a persona — use-os no MÁXIMO para informar SUA decisão sobre o que perguntar, nunca para citar.

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
            ? `Última pergunta feita: "${lastTurn.question ?? ""}" (plan_id=${lastTurn.question_metadata?.id ?? "?"})\nIntervenções já neste turno: ${(lastTurn.interventions ?? []).length}\nResposta da outra ponta até agora (se houver): ${lastTurn.answer ? JSON.stringify(lastTurn.answer) : "(ainda não respondida)"}`
            : "(sem turno ativo — a cena acabou de entrar na fase de condução; este é o primeiro turno)";

        const turnsAnswered = Array.isArray(turnLog)
            ? turnLog.filter(t => t && t.answered_at).length
            : 0;

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**ANÁLISE PRÉVIA DA ENTREGA** (gerada na prep)
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

**FALA RECÉM-RECEBIDA DA OUTRA PONTA**
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

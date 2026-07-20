import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble, EXTEMPORANEOUS_ANSWER_PRINCIPLE } from "../lib/agentPreamble.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { ACTION_SCHEMA_DESCRIPTION, validateAction, extractReadyAction } from "../lib/superOrchestrator/actionSchema.js";
import { extractFirstJsonObject } from "../lib/jsonExtract.js";

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

    constructor(openaiClient, model, reasoningEffort = null) {
        if (!model) throw new Error("Missing model for SuperOrchestratorAgent");
        if (reasoningEffort != null && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) {
            throw new Error(`Invalid reasoningEffort for SuperOrchestratorAgent: ${reasoningEffort}`);
        }
        this.client = openaiClient;
        this.model = model;
        // Opt-in: quando setado, injeta reasoning.effort no payload. Produção
        // (routes/interview.js) não passa → payload sem `reasoning` = default da
        // API. Usado hoje só pelo harness A/B para testar low vs medium.
        this.reasoningEffort = reasoningEffort;
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
- Você NÃO PODE finalizar antes de {{MIN_TURNS}} turnos respondidos. Se emitir finalize cedo demais, o código sobrescreve para uma ação válida — exceto se finalize_reason="student_disengaged".
- Você NÃO PODE perguntar de novo uma questão que já está em memory.questions_covered.
- Limite total: {{MAX_TURNS}} turnos. Depois disso o código força finalize automático.

${EXTEMPORANEOUS_ANSWER_PRINCIPLE}

QUANDO USAR CADA action.kind:

- "ask": avançar para a próxima pergunta. Pode ser:
  * Uma pergunta do PLANO que ainda não foi respondida (preferida). Use o id em plan_question_id e copie os arrays (objectives, concerns, etc.) DIRETAMENTE do item do plano.
  * Uma pergunta ESPONTÂNEA sua (plan_question_id=null) quando faz sentido retomar um tópico anterior (revisit_topic="...") ou seguir uma deixa interessante da outra ponta. Nesse caso, arrays vazios são aceitos — o rationale carrega o porquê.
  * Sempre coloque a fala da pergunta em action.message (vai por TTS). Para perguntas do plano, você pode REFORMULAR a pergunta na voz da persona em vez de copiar literalmente — desde que preserve a intenção, e desde que a reformulação soe natural para a persona (cliente decisor não diz "reconstrua a fórmula"; perguntaria pela intuição, pela consequência prática, pela sensibilidade).

- "follow_up": pedir complemento sobre o turno ATUAL quando a resposta tem incoerência relevante, está incompleta em relação ao escopo da pergunta, OU contradiz algo verificável (ver bloco VERIFICAÇÃO DE CONTRADIÇÕES abaixo). ATENÇÃO ao PRINCÍPIO DA RESPOSTA FORMULÁVEL DE CABEÇA (acima): numa sondagem quantitativa, uma resposta qualitativa — direção + mecanismo + ordem de grandeza — NÃO é "incompleta"; aceite-a e siga, NÃO dispare follow_up só porque falta o valor exato recalculado. SEMPRE acompanhe de follow_up_reason — escolha o valor que mais se aplica: "incoherence" | "incomplete" | "diminishing_returns" | "contradicts_work" | "contradicts_earlier_self". FOLLOW_UP É EXCEÇÃO, NÃO ROTINA: o padrão é aceitar a resposta (mesmo imperfeita), registrar lacunas em memory.open_threads — que a avaliação verá — e seguir com ask. Numa entrevista típica, o TOTAL de follow_ups fica em 2 a 4; passar disso é sinal de interrogatório (o contexto do turno informa os contadores). Limites duros: por "incomplete"/"incoherence", NO MÁXIMO 1 por pergunta e apenas quando a lacuna for MATERIAL para a agenda; por "contradicts_*", no máximo 2, e somente contradição CONCRETA (você consegue citar o trecho). Cobrança de fonte/base numérica já feita e não respondida NUNCA se repete — registre e avance. A pressão é sobre o conteúdo, no registro da persona — não sobre a pessoa.

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

PEDIDO DE PULO (precedência máxima — checa ANTES de qualquer outra coisa):

A outra ponta tem o direito de pular qualquer pergunta. Essa decisão é dela, não sua. Se ela sinalizar pulo, respeite SEM RESISTÊNCIA. Três casos:

(1) **Explícito e direto** — fala como "não vou responder essa", "podemos pular?", "passa pra próxima", "não quero responder isso", "pula essa", "skipa essa pergunta": kind="ask" IMEDIATAMENTE para a próxima pergunta do plano (ou espontânea coerente). NÃO QUESTIONE. NÃO TENTE convencer. Atualize memory.questions_skipped com o id da pergunta atual. action.message é curto, em personagem, sem julgamento ("tudo bem, vamos adiante", "sem problema, próxima"). Esse caso é o mais comum quando a entrevistada quer pular — vale a sua boa-fé.

(2) **Ambíguo / dúvida** — sinais como "não sei mesmo essa", "tá difícil", "essa eu não consigo", "não pensei nisso", "tô travado(a)": kind="follow_up" com follow_up_reason="confirm_skip". action.message confirma uma vez, em personagem, sem pressão: "tudo bem se você quiser pular essa, é só me dizer. ou prefere tentar ainda?". Aqui você está dando à pessoa a chance de pular sem precisar pedir. Próximo turno: se ela confirmar o pulo, age como em (1); se ela tentar responder, prossegue normal.

(3) **Procrastinação sem pedido** — a pessoa está enrolando mas NÃO pediu pulo nem sinalizou dúvida (ex.: muda de assunto, comenta de lado, evade indiretamente): comportamento atual (follow_up por incoherence/incomplete). NÃO ofereça pulo aqui — seria abrir uma porta que a pessoa não pediu.

REGRAS:
- Pulo NUNCA conta contra a pessoa pessoalmente. Múltiplos pulos podem ativar diminishing_returns_overall para finalizar a conversa, mas isso é decisão geral, não punição.
- Se você confirmou (caso 2) e ela confirmou de volta o pulo, agora é caso (1) — pula sem mais perguntar.
- NÃO repita perguntas puladas no mesmo run. Plano puladas ficam em memory.questions_skipped — não revisite.
- Se TODAS as perguntas do plano forem puladas, kind="finalize" com finalize_reason="diminishing_returns_overall" e fala curta sobre encerrar para a pessoa poder revisar com calma e comentar depois.

REGRA ANTI-INDUÇÃO (INVIOLÁVEL — vale para follow_up E para reformulações de ask):
O propósito da conversa é medir o domínio da OUTRA PONTA. Sua pergunta NUNCA pode conter a resposta que você espera, uma paráfrase dela, nem um cardápio de alternativas para a pessoa escolher.
- PROIBIDO descrever o conteúdo que falta ("o que muda quando X deixa de ser único e passa a ser gravado, recortado e reproduzido?") — descrever o alvo é ditar a resposta: a pessoa repete a sua formulação e o sinal de domínio morre.
- PROIBIDO cardápio: "você está pensando em A, em B, ou em outro ponto?" — a pessoa escolhe a sua alternativa (a) sem demonstrar nada.
- Quando a resposta vier vaga, errada ou incompleta, cobre SEM conteúdo: peça o mecanismo ("por quê?", "como isso funciona no seu caso?"), um exemplo concreto, a consequência prática, ou simplesmente reafirme a pergunta original com outras palavras — sem adicionar os elementos que você quer ouvir.
- ESPAÇO DE ARGUIÇÃO: perguntas (do plano ou espontâneas) versam sobre o que a ENTREGA usa e afirma. NÃO exija ponte com autores, capítulos ou materiais do documento motivador que a outra ponta não usou, e não os ofereça como menu ("qual você escolheria — A, B, C ou D?"). Material não usado pela entrega serve, no máximo, para VOCÊ verificar contradições — não para gerar cobrança de repertório.
- RECONHECIMENTOS NEUTROS: ao aceitar uma resposta (inclusive a imperfeita, após o cap de follow_ups), reconheça sem validar conteúdo: "certo", "entendi", "ok, vamos adiante". PROIBIDO "era isso que eu queria ouvir", "agora sim apareceu [X]", "exatamente" — isso confirma a dica retroativamente e ensina a jogar o jogo, além de soar como gabarito falado.

VERIFICAÇÃO DE CONTRADIÇÕES POR TURNO (rotina ativa — só roda se NÃO houver pedido de pulo na fala recebida):

A cada turno, ANTES de escolher entre ask / follow_up / etc., faça duas checagens explícitas sobre a fala recém-recebida da outra ponta:

(1) **Contradiz a entrega?** A fala afirmou algo verificável contra o material entregue? Se sim, use file_search ANCORADO no termo/número/conceito mencionado (consulte sempre que houver claim factual: valor numérico, premissa, escolha de método, recomendação, citação de seção). Se file_search confirmar contradição (a entrega diz X, a fala diz Y), kind="follow_up" com follow_up_reason="contradicts_work". Cite na action.message o trecho específico da entrega na voz da persona ("aqui no documento você escreve [X], mas agora me diz [Y] — como reconcilia?"). NÃO ignore inconsistências menores; aceitá-las silenciosamente sinaliza que o registro vale menos do que a fala atual.

(2) **Contradiz a si mesma antes?** A fala atual contradiz algo que a própria outra ponta disse em turnos anteriores DESTA entrevista? Consulte o histórico da conversa (conv_chat). Se houver contradição real (não apenas refinamento ou esclarecimento), kind="follow_up" com follow_up_reason="contradicts_earlier_self". Cite em action.message o que ela mesma disse antes ("você tinha me dito [X] mais cedo, agora está dizendo [Y] — qual é a versão que vale?"). Este caso é menos comum que (1) mas igualmente legítimo de cobrar.

Prioridade entre os dois quando coexistem: (1) é mais grave. Cobre primeiro a contradição com a entrega; se for resolvida, na próxima rodada cobre a contradição com a fala anterior se ela persistir.

LIMITES:
- "Refinamento" não é contradição. A outra ponta pode complementar, qualificar, adicionar nuance — isso é resposta evoluindo. Contradição é quando a NOVA afirmação INVALIDA a anterior (ou a da entrega). Só dispare quando você vê um conflito real, não uma variação aceitável.
- Se a contradição for trivial ou claramente lapso de fala (ex.: errou um número óbvio, depois corrigiu na mesma frase), NÃO dispare follow_up. Trate como ruído e siga.
- CONVENÇÃO NUMÉRICA: a entrega pode usar convenção pt-BR (ponto de milhar, vírgula decimal: 1.234,56) ou en-US (1,234.56). Antes de tratar divergência de escala/ordem de grandeza como contradição, reconcilie a convenção pelo próprio documento (confira via file_search dois ou mais números independentes cuja grandeza o contexto revela). Divergência que desaparece lendo o separador na outra convenção NÃO é contradição citável — não dispare follow_up por ela, e NUNCA induza a outra ponta a "corrigir" números com base só na sua leitura do separador.
- DIREÇÃO DE EFEITO: pergunta desconfiada com a direção embutida ("isso não infla o resultado?") é legítima e combina com personas céticas — DESDE QUE a direção tenha sido VERIFICADA: você consegue citar a conta ou os números que a sustentam (use file_search). Direção por palpite é PROIBIDA — a outra ponta tende a concordar e o registro cristaliza um erro. Sem verificação, pergunte aberto ("essa escolha mexe no resultado em qual direção — a favor ou contra? por quê?") e deixe a outra ponta produzir direção e mecanismo.
- O cap dos 2 follow_ups consecutivos por turno vale igualmente aqui: se a outra ponta não reconcilia em 2 tentativas, registre em memory.open_threads ou free_notes e siga em ask.

REGISTRO EM MEMORY:
- Contradições reconciliadas satisfatoriamente: anote sucintamente em free_notes ("turno 4: contradição taxa 8%/12% — reconciliou como 8% real").
- Contradições NÃO reconciliadas após 2 follow_ups: anote em open_threads ("conflito não resolvido sobre [X] — vale revisitar").
- Use isso pra evitar re-cobrar a mesma contradição em turnos futuros sem motivo.

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
- Transições entre perguntas são NEUTRAS (ver REGRA ANTI-INDUÇÃO): não recapitule "o que apareceu" na resposta anterior nem elogie o encaixe com o que você esperava.

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
     * @param {string|null} p.studentGenderHint - "f"|"m"|"n"|null preferência declarada
     * @param {string} p.interactionMode - "text" | "audio"
     * @param {object|null} p.meterCtx
     * @param {function():void} [p.onFirstDelta] - callback opcional disparado
     *        UMA VEZ no primeiro token de texto emitido pelo modelo (após o
     *        chain-of-thought interno e antes do output completo). Usado pelo
     *        despachante SSE para sinalizar "respondendo" ao frontend no
     *        momento real em que a fala começa a ser produzida.
     * @param {function(string,string):void} [p.onMessageReady] - callback
     *        opcional disparado UMA VEZ quando action.kind e action.message
     *        fecham no JSON em streaming (antes de rationale/memory). Recebe
     *        (kind, message). Usado para disparar o TTS cedo. Ver extractReadyAction.
     * @param {number|null} [p.minTurnsBeforeFinalize] - piso de turnos antes de
     *        poder finalizar; derivado do nº de perguntas em routes/interview.js.
     * @param {number|null} [p.maxTurns] - teto duro de turnos; idem.
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
        studentGenderHint = null,
        interactionMode = "text",
        meterCtx = null,
        onFirstDelta = null,
        onMessageReady = null,
        minTurnsBeforeFinalize = null,
        maxTurns = null,
    }) {
        // Guardrails de turno: a fonte de verdade das fórmulas é routes/interview.js
        // (maxTurnsFor / minTurnsBeforeFinalizeFor), que passa os valores já
        // calculados. Fallback defensivo deriva do tamanho do plano para nunca
        // vazar o placeholder no prompt nem reintroduzir os antigos 5/30 fixos.
        const plannedCount = interviewPlan?.questions?.length ?? 0;
        const minTurns = minTurnsBeforeFinalize ?? (plannedCount ? Math.ceil(plannedCount / 2) : 1);
        const maxT = maxTurns ?? (plannedCount ? plannedCount * 3 : 30);
        const resolvedBody = this.systemPromptBody
            .replace("{{MIN_TURNS}}", String(minTurns))
            .replace("{{MAX_TURNS}}", String(maxT));
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode, studentName, studentGenderHint })}

${resolvedBody}`;

        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const memoryBlock = memory
            ? JSON.stringify(memory, null, 2)
            : "(vazio — este é o primeiro turno do super-orquestrador nesta entrevista)";
        const planSummary = (interviewPlan?.questions ?? []).map((q, i) =>
            `${q.id ?? i}: ${q.question}`
        ).join("\n");
        const lastTurn = Array.isArray(turnLog) && turnLog.length > 0 ? turnLog[turnLog.length - 1] : null;
        // Contadores de insistência (regras no systemPrompt): por pergunta
        // (1 incomplete/incoherence; 2 contradições) e por ENTREVISTA (alvo
        // total 2–4 — follow_up é exceção, não rotina).
        const lastIvs = lastTurn?.interventions ?? [];
        const softUsed = lastIvs.filter(iv => iv?.follow_up_reason === "incomplete" || iv?.follow_up_reason === "incoherence").length;
        const contraUsed = lastIvs.filter(iv => iv?.follow_up_reason === "contradicts_work" || iv?.follow_up_reason === "contradicts_earlier_self").length;
        const totalFups = (Array.isArray(turnLog) ? turnLog : [])
            .reduce((sum, t) => sum + (t?.interventions ?? []).filter(iv => iv?.type === "follow_up").length, 0);
        const budgetLine = `Follow_ups na ENTREVISTA até agora: ${totalFups} (alvo total: 2 a 4 — acima disso, aceite e registre em open_threads em vez de insistir). Nesta pergunta: incomplete/incoherence ${softUsed}/1${softUsed >= 1 ? " — ESGOTADO (PROIBIDO follow_up por completude: registre a pendência e avance)" : ""}; contradições ${contraUsed}/2${contraUsed >= 2 ? " — ESGOTADO (registre o conflito e avance)" : ""}`;
        const lastTurnBlock = lastTurn
            ? `Última pergunta feita: "${lastTurn.question ?? ""}" (plan_id=${lastTurn.question_metadata?.id ?? "?"})\nIntervenções já neste turno: ${lastIvs.length}\n${budgetLine}\nResposta da outra ponta até agora (se houver): ${lastTurn.answer ? JSON.stringify(lastTurn.answer) : "(ainda não respondida)"}`
            : "(sem turno ativo — a cena acabou de entrar na fase de condução; este é o primeiro turno)";

        const turnsAnswered = Array.isArray(turnLog)
            ? turnLog.filter(t => t && t.answered_at).length
            : 0;

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**ANÁLISE PRÉVIA DA ENTREGA** (gerada na prep)
${JSON.stringify(workAnalysis ?? {}, null, 2)}

**PLANO DE PERGUNTAS** (${plannedCount} ${plannedCount === 1 ? "item pré-gerado" : "itens pré-gerados"} — você pode pular ou reformular; cubra o plano e finalize, não invente perguntas além dele sem motivo claro)
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
        // Dica de roteamento de cache (não altera a saída): agrupa os turnos de
        // todos os alunos do mesmo trabalho (mesma agenda no prefixo estável).
        if (meterCtx?.workId) payload.prompt_cache_key = `iv:${meterCtx.workId}`;
        if (this.reasoningEffort) {
            payload.reasoning = { effort: this.reasoningEffort };
        }
        if (vectorStoreId) {
            payload.tools = [{ type: "file_search", vector_store_ids: [vectorStoreId] }];
        }

        // Streaming sempre habilitado quando o caller passou onFirstDelta —
        // só assim conseguimos sinalizar "respondendo" no momento real do
        // primeiro token de texto. Caller que não precisa disso (cenários
        // sem SSE) pode chamar sem callback e o agente segue blocking.
        const wantStream = typeof onFirstDelta === "function";

        log.prompt("AGENT:SuperOrchestrator", `system+user (${systemPrompt.length + userContent.length} chars)${wantStream ? " [stream]" : ""}`);

        // Retry SÓ na chamada da API — a classe transitória (timeout/5xx/429)
        // que vira "tive um problema aqui" para o aluno sem culpa dele. NÃO
        // re-tentamos falha de parse/schema: aí o response já foi obtido (e
        // provavelmente commitado na Conversations API), então um novo call
        // duplicaria o item do turno. Também não re-tentamos depois de já ter
        // saído texto parcial (firstDeltaFired) — pode ter commitado. Esgotado
        // o retry, o erro sobe e o caller cai no fallback (ask_repeat).
        const MAX_API_ATTEMPTS = 2;
        let firstDeltaFired = false;
        let text;
        let apiErr = null;
        for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
            try {
                if (wantStream) {
                    payload.stream = true;
                    const stream = await log.span("AGENT:SuperOrchestrator", `responses.create[stream]${attempt > 1 ? ` retry#${attempt}` : ""}`, () =>
                        meteredResponses(
                            { ...meterCtx, agentLabel: "AGENT:SuperOrchestrator", model: this.model },
                            () => this.client.responses.create(payload)
                        )
                    );
                    const collected = [];
                    let finalResponse = null;
                    let messageSignaled = false;
                    for await (const event of stream) {
                        if (event?.type === "response.output_text.delta") {
                            if (!firstDeltaFired) {
                                firstDeltaFired = true;
                                try { onFirstDelta(); }
                                catch (cbErr) { log.error("AGENT:SuperOrchestrator", `onFirstDelta callback threw: ${cbErr.message}`); }
                            }
                            if (typeof event.delta === "string") collected.push(event.delta);
                            // Streaming-parse: assim que action.kind + action.message
                            // fecham no JSON parcial, sinaliza para o caller disparar o
                            // TTS sem esperar rationale/memory. Dispara no máximo uma vez.
                            if (!messageSignaled && typeof onMessageReady === "function") {
                                const ready = extractReadyAction(collected.join(""));
                                if (ready) {
                                    messageSignaled = true;
                                    try { onMessageReady(ready.kind, ready.message); }
                                    catch (cbErr) { log.error("AGENT:SuperOrchestrator", `onMessageReady threw: ${cbErr.message}`); }
                                }
                            }
                        } else if (event?.type === "response.completed") {
                            finalResponse = event.response ?? null;
                        }
                    }
                    // Preferimos output_text da Response completa (canônico). Cai
                    // pra concatenação dos deltas se a Response não veio.
                    text = finalResponse?.output_text
                        ?? collected.join("")
                        ?? "";
                } else {
                    const response = await log.span("AGENT:SuperOrchestrator", `responses.create${attempt > 1 ? ` retry#${attempt}` : ""}`, () =>
                        meteredResponses(
                            { ...meterCtx, agentLabel: "AGENT:SuperOrchestrator", model: this.model },
                            () => this.client.responses.create(payload)
                        )
                    );
                    text = response.output_text || "";
                }
                apiErr = null;
                break;
            } catch (err) {
                apiErr = err;
                log.error("AGENT:SuperOrchestrator", `chamada falhou (tentativa ${attempt}/${MAX_API_ATTEMPTS}): ${err.message}`);
                // Não re-tenta se já saiu texto parcial (risco de duplicar o item
                // do turno) ou se esgotou as tentativas.
                if (firstDeltaFired || attempt >= MAX_API_ATTEMPTS) break;
                await new Promise((r) => setTimeout(r, 600 * attempt));
            }
        }
        if (apiErr) throw apiErr;
        const extracted = extractFirstJsonObject(text);
        if (!extracted) {
            log.error("AGENT:SuperOrchestrator", `no JSON in response: ${log.preview(text, 200)}`);
            throw new Error("SuperOrchestratorAgent: no JSON in response");
        }
        if (extracted.trailing) {
            log.warn("AGENT:SuperOrchestrator", `texto residual após o JSON ignorado (${extracted.trailing.length} chars): ${log.preview(extracted.trailing, 120)}`);
        }
        let parsed;
        try { parsed = JSON.parse(extracted.json); }
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

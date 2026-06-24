import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { PARTICIPANT_ROLES, ROLE_LABEL } from "../lib/scenarios/mockEngine.js";
import { FORMS, FORM_LABELS, FORM_DYNAMICS, FORM_DEFAULT_WORK, formKind } from "../lib/scenarios/interactionForms.js";
import { extractJsonObject } from "../lib/scenarios/scenarioActionSchema.js";
import { extractJsonStringValue } from "../lib/superOrchestrator/actionSchema.js";

/**
 * ScenarioAssistantAgent — assistente do PROFESSOR no ESTÚDIO DE CENÁRIOS.
 *
 * Conhece o MODELO COMPLETO do cenário (formas e suas dinâmicas, fora de escopo,
 * premissas, informações privadas por interação, tempo, trabalho do aluno,
 * mensagens de exemplo, personas com profundidade) e sabe não só PROPOR coisas
 * novas como AJUSTAR o que já existe (ops add/update). NUNCA salva — devolve
 * uma resposta conversacional + propostas estruturadas que a interface aplica ao
 * cenário em edição; o professor revisa nas abas e clica Salvar. Modelo:
 * fast_model. Audience: professor_via_ui.
 */
export class ScenarioAssistantAgent {
    static TYPE = "scenario_assistant";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ScenarioAssistantAgent");
        this.client = openaiClient;
        this.model = model;

        const roleList = PARTICIPANT_ROLES.map(v => `${v} (${ROLE_LABEL[v]})`).join(", ");
        const formBlock = FORMS.map(f => `  - ${f} — ${FORM_LABELS[f]}${FORM_DYNAMICS[f] ? `: ${FORM_DYNAMICS[f]}` : " (a dinâmica vem do form_prompt que o professor escreve)"}`).join("\n");

        this.systemPromptBody = `Você é o assistente de configuração do professor no ESTÚDIO DE CENÁRIOS. Ajuda a desenhar uma cena de role-play multiagente em linguagem natural, com domínio PROFUNDO de como cada parte funciona. Você NÃO salva nada — você PROPÕE (criar ou ajustar), e o professor revisa e salva na interface.

═══════ O MODELO (entenda a fundo antes de propor) ═══════

CENÁRIO (nível geral):
- "name" + "description": o nome e a explicação geral da cena (é o que o enunciado/PDF detalha ao aluno).
- "out_of_scope" (FORA DE ESCOPO): assuntos que NUNCA serão abordados na cena. O aluno é avisado; se ele tocar nesses temas, as personas DESCONVERSAM (sem meta-comentar) e o sistema mostra uma dica fora do role-play. Use para impedir desvios (ex.: "questões salariais; o mérito político da lei").
- "premissas": pressupostos que aluno e personas já tomam como dados. As personas só cobram se o aluno CONTRARIAR uma premissa. Use para fixar o terreno (ex.: "o orçamento já foi aprovado; assuma a base de clientes de 2024").

PERSONA (um personagem reutilizável da cena). Campos: role (quem é, em uma frase), tone (tom/estilo), description, authority (o que pode decidir), gender, objectives[], concerns[], decision_criteria[], constraints[], information_needs[], evaluation_mode[], knowledge_scope[] (o que ela sabe), knowledge_level (alto/médio/baixo), example_questions[] (falas típicas DELA, na voz da persona — não as perguntas que alguém faria A ela). Personas ricas geram conversas melhores — proponha objetivos e preocupações concretos, não genéricos.

INTERAÇÃO (cada etapa ORDENADA; o aluno passa por elas EM SEQUÊNCIA, da 1ª à última). A ORDEM É PARTE DO DESENHO: se o professor descreve uma sequência ("primeiro X, depois Y, por fim Z"; "a 1ª e a última devem ser com o CFO"), crie/organize as etapas EXATAMENTE nessa ordem. Para colocar uma etapa numa posição específica (nova ou existente), use o campo "position" (número 1-based). A peça central é a FORMA, que define a DINÂMICA (quem apresenta, quem conduz, como a persona trata o trabalho do aluno). Formas válidas (campo "form"):
${formBlock}
  • A forma "deliberacao" é a única em que DUAS personas conversam entre si e o aluno observa (precisa de exatamente 2 participantes + um "focus"). Todas as outras são aluno↔persona(s).
  • "custom" exige um "form_prompt" descrevendo a dinâmica à mão. Nas demais, "form_prompt" é opcional (nuance).
  • TERMINOLOGIA: o campo "form_prompt" é o que a INTERFACE chama de "Prompt da dinâmica". Quando o professor pedir para "preencher / detalhar / explicitar a DINÂMICA" de uma ou mais interações, ele está falando do "form_prompt" — então EMITA "form_prompt" em cada interação pedida (uma descrição curta de como aquela etapa transcorre: quem conduz, o tom, o que a persona faz). NÃO confunda dinâmica com "example_questions" (falas) e NÃO presuma que a FORMA sozinha já atende o pedido — se o professor pediu a dinâmica e você não emitiu "form_prompt", você NÃO atendeu.
  • PREENCHA "form_prompt" JÁ NA PROPOSTA INICIAL (não só quando pedido depois) sempre que o pedido do professor descrever COMO a persona CONDUZ a etapa — o tom de abertura, o ritmo de revelação, o que ela oferece espontaneamente vs. só sob pergunta, quem puxa a conversa. Frases como "os fornecedores começam falando maravilhas", "vão revelando passo a passo", "só sob perguntas do aluno", "não mentem mas não falam espontaneamente das limitações", "o CFO pressiona por coerência no fechamento" são DIREÇÃO DE CONDUÇÃO → vão no "form_prompt" daquela etapa (ex.: "Comece elogiando a solução; só admita limitações se o aluno perguntar diretamente; nunca as ofereça espontaneamente"). Isso é diferente de: "instruction" (a tarefa MOSTRADA ao aluno), "private_info" (os FATOS que ficam escondidos) e "example_questions" (falas avulsas). O mesmo pedido costuma alimentar os quatro — não deixe o "form_prompt" vazio quando a condução foi descrita.
- "instruction": a tarefa do aluno nesta etapa — é MOSTRADA a ele e também orienta as personas.
- "participants": as personas desta etapa, por NOME, cada uma com um "role": ${roleList}. (Em "deliberacao" o role é ignorado.)
- "time_limit_min": tempo opcional (minutos) — mostra cronômetro; a persona conduz pelo tempo e avisa quando falta pouco; vazio = sem limite.
- "includes_student_work": se esta etapa pede o upload do trabalho do aluno (a persona o lê). Default por forma — só mexa se o professor pedir.
- "example_questions": exemplos de falas DA PERSONA nesta etapa (inspiração para o orquestrador) — RESPEITANDO A DIREÇÃO DA FORMA. Numa etapa em que o ALUNO entrevista/pergunta à persona (consultoria/coleta, entrevista, questionamento), os exemplos são FALAS DA PERSONA respondendo/dando contexto ("Funcionamos das 6h às 20h; o pico é de manhã", "Posso te explicar; o que você quer saber primeiro?") — NUNCA as perguntas de levantamento que cabem ao ALUNO ("Como é o consumo ao longo do dia?"). Atribuir à persona as perguntas do aluno INVERTE o papel: a persona passa a entrevistar o aluno sobre dados que ela mesma deveria ter. Se a etapa é uma APRESENTAÇÃO do aluno, os exemplos são as perguntas/reações que a persona faz ao ouvi-lo.
- "private_info": informações que as personas TÊM e o aluno NÃO — reveladas só nesta etapa, e só se o aluno PERGUNTAR/conduzir (nunca de graça). Cada item tem um "text" e a lista de "personas" (por nome, entre as participantes) que a detêm. Use para criar assimetria de informação (ex.: numa consultoria, a fonte só conta um detalhe se perguntada).

═══════ DESENHO DE INFORMAÇÃO (o NÚCLEO de um cenário multi-etapa) ═══════
Num cenário com várias interações, a ASSIMETRIA DE INFORMAÇÃO é o coração do aprendizado e da avaliação: o que importa é o que CADA persona sabe e o que NÃO sabe, e o que o aluno precisa DESCOBRIR ao longo das etapas. Trate isso como prioridade DESDE O INÍCIO — não é detalhe de acabamento.
- ENTREVISTE o professor sobre o desenho de informação. Ao montar (ou revisar) um cenário multi-etapa, pergunte explicitamente, ANTES de fechar: o que cada persona conhece e o que ignora? que informação é privada de quem — só sai se o aluno perguntar? o que o aluno deve DESCOBRIR, e em qual etapa? existe fato que uma etapa específica existe justamente para revelar? Se o professor não deixou isso claro, PERGUNTE — não preencha por conta própria, porque é exatamente aqui que mora a nota.
- ARCO DE DESCOBERTA (regra dura): NUNCA semeie numa persona de uma etapa ANTERIOR o conhecimento específico que uma etapa POSTERIOR existe para revelar. Se as etapas 2 e 3 existem para o aluno descobrir as diferenças entre dois fornecedores, a persona da etapa 1 (ex.: o CFO) NÃO entrega essas diferenças — no máximo pede que o aluno investigue e compare. Cuidado especial com "conhecimento preliminar" amplo numa persona inicial: ele vaza o que vem depois, porque o modelo elabora o vago em específico e estraga a descoberta. Escopo amplo demais numa persona de abertura é um cheiro de vazamento — questione.
- Mapeie para os campos certos: o "knowledge_scope" de cada persona contém SÓ o que ela plausivelmente saberia naquele ponto (sem antecipar o que outra etapa revela); "private_info" guarda o que ela só conta se perguntada (a moeda da descoberta); "out_of_scope" barra temas que ninguém aborda. Ao desenhar cada persona, pergunte-se: "isto ela saberia mesmo? isto pertence a ESTA etapa ou a uma posterior?".

═══════ COMO RESPONDER (SEMPRE só JSON, neste formato) ═══════
{
  "reply": "resposta conversacional ao professor, em português, curta e prática: o que você propôs/ajustou e por quê. Se faltar informação para decidir bem, PERGUNTE em vez de inventar. FIDELIDADE OBRIGATÓRIA: o reply deve descrever SOMENTE o que de fato está nas ops abaixo. NUNCA afirme ter preenchido/alterado um campo que você não emitiu — ex.: só diga que 'preenchi a dinâmica' se cada interação citada tiver 'form_prompt' nas ops. Se não emitiu, não alegue.",
  "scenario_patch": { "name"?: "...", "description"?: "...", "out_of_scope"?: "...", "premissas"?: "..." } | null,
  "personas": [
    { "op": "add" | "update", "name": "<chave: nome da persona>", "from_template"?: "<nome de um template da biblioteca p/ usar como base>",
      "role"?, "tone"?, "description"?, "authority"?, "gender"?,
      "objectives"?: [], "concerns"?: [], "knowledge_scope"?: [], "knowledge_level"?,
      "decision_criteria"?: [], "constraints"?: [], "information_needs"?: [], "evaluation_mode"?: [], "example_questions"?: [] }
  ],
  "interactions": [
    { "op": "add" | "update", "ref"?: <para update: o número (1-based) da etapa OU o título atual>,
      "position"?: <número 1-based: posição desejada da etapa na sequência (insere/move para lá)>,
      "title"?, "form"?: "<uma das formas válidas>", "form_prompt"?, "instruction"?, "focus"?,
      "time_limit_min"?: <número de minutos ou null>, "includes_student_work"?: <true|false>,
      "participants"?: [ { "persona_name": "<persona do cenário ou recém-proposta>", "role"?: "<um dos papéis>" } ],
      "example_questions"?: [],
      "private_info"?: [ { "text": "...", "personas": ["<nome de participante>", ...] } ] }
  ]
}

═══════ REGRAS ═══════
- INCREMENTAL e fiel ao pedido: não invente um cenário inteiro se o professor só pediu uma persona ou um ajuste. Para AJUSTAR algo que já existe, use op:"update" referenciando pelo nome (persona) ou pelo número/título (interação) — mande SÓ os campos que mudam.
- ORDEM das interações: respeite a sequência que o professor descreveu. Para mover uma etapa existente para outra posição, use op:"update" com "ref" (número/título atual) + "position" (destino). Para criar já numa posição específica, use op:"add" com "position". Sem "position", a etapa nova vai para o fim.
- Em "personas", liste só o que muda/nasce. Para reusar um template e adaptá-lo, use op:"add" com "from_template" e sobrescreva os campos que quiser.
- Em "participants", refira personas por NOME (a interface resolve o id). Use papéis e formas APENAS das listas válidas. "deliberacao" precisa de exatamente 2 personas.
- "private_info" só faz sentido em formas com aluno (não em deliberacao) e as personas citadas devem estar entre as participantes.
- Aproveite fora_de_escopo/premissas/private_info quando ajudarem o desenho pedagógico — são o que dá controle ao professor. Mas não os force onde não cabem.
- Seja conciso. Proponha o essencial e ofereça refinar.`;
    }

    /**
     * @param {object} p
     * @param {object} p.scenario   estado atual completo (visão por NOME): { name, description, out_of_scope, premissas, personas:[{name,role,...}], interactions:[{title,form,instruction,participants:[{persona_name,role}],private_info:[{text,personas}],...}] }
     * @param {Array}  p.templates  biblioteca [{name, role, description}]
     * @param {Array}  p.history    turnos anteriores [{role:'user'|'assistant', content}]
     * @param {string} p.message    mensagem do professor
     * @param {object|null} p.meterCtx
     */
    async chat({ scenario = {}, templates = [], history = [], message, meterCtx = null, onReplyDelta = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const histBlock = (history || []).slice(-8).map(h => `${h.role === "assistant" ? "ASSISTENTE" : "PROFESSOR"}: ${h.content}`).join("\n") || "(início da conversa)";
        const tmplBlock = (templates || []).map(t => `- ${t.name} (${t.role})${t.description ? ` — ${String(t.description).slice(0, 120)}` : ""}`).join("\n") || "(nenhum)";
        const userContent = `**ESTADO ATUAL DO CENÁRIO EM EDIÇÃO** (interações numeradas para você referenciar em ops de update)
${JSON.stringify(this.#scenarioView(scenario), null, 2)}

**TEMPLATES DISPONÍVEIS NA BIBLIOTECA** (pode reusar como base via from_template)
${tmplBlock}

**HISTÓRICO DA CONVERSA**
${histBlock}

**MENSAGEM DO PROFESSOR**
${message}

Responda SOMENTE com o JSON do formato especificado.`;

        log.prompt("AGENT:ScenarioAssistant", `system+user (${systemPrompt.length + userContent.length} chars)${onReplyDelta ? " [stream]" : ""}`);
        // Esforço de raciocínio BAIXO: a tarefa é propor edições estruturadas (não
        // resolver problema difícil); o ganho de latência é grande e a qualidade de
        // ordenação/forma se mantém (verificado). Ajustável se algum caso pedir mais.
        const payload = { model: this.model, instructions: systemPrompt, input: [{ role: "user", content: userContent }], reasoning: { effort: "low" }, truncation: "auto" };
        // STREAMING (onReplyDelta): o `reply` é o 1º campo do JSON, então sai antes
        // das propostas — extraímos seu valor incrementalmente e emitimos os deltas
        // (o professor vê o texto fluindo). As propostas só são parseadas no fim.
        let text;
        if (typeof onReplyDelta === "function") {
            const stream = await log.span("AGENT:ScenarioAssistant", "responses.create[stream]", () =>
                meteredResponses({ ...meterCtx, agentLabel: "AGENT:ScenarioAssistant", model: this.model }, () =>
                    this.client.responses.create({ ...payload, stream: true })));
            const collected = []; let finalResponse = null, sent = 0;
            for await (const event of stream) {
                if (event?.type === "response.output_text.delta") {
                    if (typeof event.delta === "string") collected.push(event.delta);
                    const m = extractJsonStringValue(collected.join(""), "reply");
                    if (m && m.value && m.value.length > sent) { try { onReplyDelta(m.value.slice(sent)); } catch (e) { log.error("AGENT:ScenarioAssistant", `onReplyDelta: ${e.message}`); } sent = m.value.length; }
                } else if (event?.type === "response.completed") { finalResponse = event.response ?? null; }
            }
            text = finalResponse?.output_text ?? collected.join("");
        } else {
            const response = await log.span("AGENT:ScenarioAssistant", "responses.create", () =>
                meteredResponses({ ...meterCtx, agentLabel: "AGENT:ScenarioAssistant", model: this.model }, () =>
                    this.client.responses.create(payload)));
            text = response.output_text || "";
        }
        const parsed = extractJsonObject(text || "");
        if (!parsed || typeof parsed.reply !== "string") {
            return { reply: "Desculpe, não consegui formular uma proposta agora. Pode reformular?", scenario_patch: null, personas: [], interactions: [] };
        }

        const out = {
            reply: parsed.reply,
            scenario_patch: this.#cleanPatch(parsed.scenario_patch),
            personas: (Array.isArray(parsed.personas) ? parsed.personas : []).map(p => this.#cleanPersonaOp(p)).filter(Boolean),
            interactions: (Array.isArray(parsed.interactions) ? parsed.interactions : []).map(it => this.#cleanInteractionOp(it)).filter(Boolean),
        };
        log.info("AGENT:ScenarioAssistant", `reply=${log.preview(parsed.reply, 80)} patch=${!!out.scenario_patch} personas=${out.personas.length} interactions=${out.interactions.length}`);
        return out;
    }

    // --- Visão do estado para o prompt: numera interações e usa nomes ---
    #scenarioView(s) {
        return {
            name: s.name || "(sem nome)",
            description: s.description || "(sem explicação)",
            out_of_scope: s.out_of_scope || "(vazio)",
            premissas: s.premissas || "(vazio)",
            personas: (s.personas || []).map(p => ({
                name: p.name, role: p.role, tone: p.tone || undefined,
                objectives: p.objectives?.length ? p.objectives : undefined,
                concerns: p.concerns?.length ? p.concerns : undefined,
            })),
            interactions: (s.interactions || []).map((it, i) => ({
                "#": i + 1, title: it.title, form: it.form, instruction: it.instruction || undefined,
                focus: it.focus || undefined, time_limit_min: it.time_limit_min || undefined,
                includes_student_work: it.includes_student_work || undefined,
                participants: (it.participants || []).map(pp => ({ persona_name: pp.persona_name, role: pp.role })),
                private_info: it.private_info?.length ? it.private_info : undefined,
            })),
        };
    }

    // --- Saneamento das propostas (enums válidos; só strings/arrays previstos) ---
    #str(v) { return typeof v === "string" ? v.trim() : ""; }
    #lines(v) { return Array.isArray(v) ? v.map(x => this.#str(x)).filter(Boolean) : (this.#str(v) ? [this.#str(v)] : []); }

    #cleanPatch(p) {
        if (!p || typeof p !== "object") return null;
        const o = {};
        for (const f of ["name", "description", "out_of_scope", "premissas"]) {
            if (typeof p[f] === "string") o[f] = p[f].trim();
        }
        return Object.keys(o).length ? o : null;
    }

    #cleanPersonaOp(p) {
        if (!p || typeof p !== "object" || !this.#str(p.name)) return null;
        const op = p.op === "update" ? "update" : "add";
        const o = { op, name: this.#str(p.name) };
        if (this.#str(p.from_template)) o.from_template = this.#str(p.from_template);
        for (const f of ["role", "tone", "description", "authority", "gender", "knowledge_level"]) {
            if (typeof p[f] === "string" && p[f].trim()) o[f] = p[f].trim();
        }
        for (const f of ["objectives", "concerns", "knowledge_scope", "decision_criteria", "constraints", "information_needs", "evaluation_mode", "example_questions"]) {
            if (p[f] !== undefined) o[f] = this.#lines(p[f]);
        }
        return o;
    }

    #cleanInteractionOp(it) {
        if (!it || typeof it !== "object") return null;
        const op = it.op === "update" ? "update" : "add";
        const o = { op };
        // ref para update: número (1-based) ou título
        if (op === "update") {
            if (typeof it.ref === "number" && it.ref > 0) o.ref = Math.round(it.ref);
            else if (this.#str(it.ref)) o.ref = this.#str(it.ref);
            else if (this.#str(it.title)) o.ref = this.#str(it.title);   // fallback: casa por título
        }
        if (typeof it.position === "number" && it.position > 0) o.position = Math.round(it.position);
        if (this.#str(it.title)) o.title = this.#str(it.title);
        if (FORMS.includes(it.form)) o.form = it.form;
        if (this.#str(it.form_prompt)) o.form_prompt = this.#str(it.form_prompt);
        if (this.#str(it.instruction)) o.instruction = this.#str(it.instruction);
        if (this.#str(it.focus)) o.focus = this.#str(it.focus);
        if (it.time_limit_min === null) o.time_limit_min = null;
        else if (typeof it.time_limit_min === "number" && it.time_limit_min > 0) o.time_limit_min = Math.round(it.time_limit_min);
        if (typeof it.includes_student_work === "boolean") o.includes_student_work = it.includes_student_work;
        if (Array.isArray(it.participants)) {
            o.participants = it.participants.filter(pp => pp && this.#str(pp.persona_name)).map(pp => ({
                persona_name: this.#str(pp.persona_name),
                role: PARTICIPANT_ROLES.includes(pp.role) ? pp.role : "questionamento",
            }));
        }
        if (it.example_questions !== undefined) o.example_questions = this.#lines(it.example_questions);
        if (Array.isArray(it.private_info)) {
            o.private_info = it.private_info.filter(pi => pi && this.#str(pi.text)).map(pi => ({
                text: this.#str(pi.text),
                personas: Array.isArray(pi.personas) ? pi.personas.map(n => this.#str(n)).filter(Boolean) : [],
            }));
        }
        // add precisa de ao menos um título OU forma para valer
        if (op === "add" && !o.title && !o.form && !o.participants?.length) return null;
        // Aplica o default de "incluir trabalho" da forma quando a forma é nova e o professor não disse o contrário.
        if (o.form && o.includes_student_work === undefined && op === "add") o.includes_student_work = !!FORM_DEFAULT_WORK[o.form];
        o.kind = o.form ? formKind(o.form) : undefined;
        return o;
    }
}

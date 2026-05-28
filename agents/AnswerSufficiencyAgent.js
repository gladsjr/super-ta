import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { formatQuestionBlock, formatFullConversation, formatCurrentTurnInterventions } from "../lib/triagePrompt.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * AnswerSufficiencyAgent
 *
 * Runs in parallel with the three triage guardrails. Decides whether the
 * student's answer is sufficient (complete + coherent enough) for the
 * interview to advance to the next planned question. Uses the principal
 * reasoning model and `file_search` against the student's PDF.
 *
 * The result is consumed only when no triage guardrail wins. If a guardrail
 * wins, the caller aborts this request via AbortSignal and ignores the
 * outcome — the request is best-effort cancelled at the SDK layer.
 *
 * Output JSON contract:
 *   {
 *     "decision": "follow_up" | "accept",
 *     "issue": "incoherence" | "incomplete" | "none",
 *     "follow_up_question": "...",
 *     "reason": "..."
 *   }
 */
export class AnswerSufficiencyAgent {
    static TYPE = "follow_up";
    static CHANNEL = "chat";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for AnswerSufficiencyAgent");
        this.client = openaiClient;
        this.model = model;
        // O system prompt final = preâmbulo padronizado (lib/agentPreamble.js)
        // + este body específico do papel. O preâmbulo é composto por chamada
        // porque depende do modo de interação (texto vs. áudio) da sessão.
        this.systemPromptBody = `Sua função específica: decidir se a resposta atual do aluno foi suficiente para que a entrevista possa avançar para a próxima pergunta planejada.

Você atua DEPOIS dos guardrails de triagem. Assuma que a mensagem do aluno é uma tentativa genuína de responder à pergunta do turno; se fosse off-topic, meta ou pedido de esclarecimento, outro agente já teria intervido.

Sua decisão é binária:
- "follow_up": a resposta tem incoerência relevante OU está incompleta com relação ao que a pergunta do turno pediu. Você produz uma pergunta de complemento curta, no tom do entrevistador, que ataca exatamente o ponto faltante ou contraditório.
- "accept": a resposta atende razoavelmente a pergunta dado o estilo do entrevistador. A entrevista avança.

QUE CONTA COMO INCOERÊNCIA — três fontes possíveis (qualquer uma vale):
(a) com o trabalho do aluno: a resposta diverge ou contradiz algo no PDF entregue. Use file_search para confirmar antes de acusar — não levante incoerência por achismo. Se confirmada, cite seção/figura/dado na follow_up_question.
(b) com a conversa: a resposta contradiz algo que o próprio aluno já disse em turnos anteriores OU em intervenções dentro deste turno. Cite o turno/trecho específico.
(c) interna: a própria resposta carrega afirmações em conflito entre si. Cite os trechos.

A follow_up_question deve apontar a inconsistência de forma específica e pedir reconciliação.

QUE CONTA COMO INCOMPLETUDE — sempre relativa à pergunta do turno:
A pergunta original, junto com seus objectives e information_needs, define o escopo do que conta como cobertura. Se a resposta esquivou parte da pergunta ou abordou só parcialmente o que era pedido, é incomplete. Não amplie o escopo da pergunta original — peça apenas o que estava no escopo e ficou faltando.

CALIBRAÇÃO DO RIGOR — faça SEMPRE:
Sua exigência advém da agenda do entrevistador.
- interaction_style "cético"/"exigente"/"investigativo" → barra alta para aceitar.
- interaction_style "colaborativo"/"diplomático"/"facilitador" → barra baixa, deixa passar respostas razoavelmente completas mesmo com pequenas lacunas.
- interaction_style "pragmático"/"objetivo"/"orientado à decisão" → barra calibrada por DECISÃO SUFICIENTE (próximo princípio), não por completude.
- evaluation_mode com itens como "explorando inconsistências", "tensionando premissas", "cobrando justificativas" → puxe para mais rigor; itens brandos → menos.
- decision_criteria é a régua exata da aceitação. Siga literalmente.
- concerns indicam onde procurar fragilidade.
Não invente rigor que não está na agenda. Em entrevistador exigente, cobre cada fragilidade detectada; em entrevistador flexível, deixe passar.

PRINCÍPIO DA DECISÃO SUFICIENTE:
Em entrevistadores pragmáticos, orientados à decisão ou objetivos, o critério real de aceitação é "decisão suficiente", não "completude acadêmica". Se a resposta do aluno — somada ao que já foi dito antes neste turno — permite ao entrevistador tomar a decisão implícita na agenda (mesmo que números exatos ou justificativas detalhadas faltem), aceite. Não cobre quantificação adicional quando a recomendação prática já está clara e estável.

Quando interaction_style e evaluation_mode puxam para direções opostas (ex.: "pragmático" + "cobra justificativa de números"), interaction_style desempata em entrevistadores orientados à decisão: a forma de conduzir vence o modo de avaliação. Pragmático cobra justificativa só até a decisão estar clara, não além.

PRINCÍPIO DOS RETORNOS DECRESCENTES (leia antes de decidir):
Você recebe um bloco dedicado **HISTÓRICO DE INTERVENÇÕES NESTE TURNO** com a lista numerada e completa das tentativas anteriores do agente neste mesmo turno (follow-ups e clarificações), incluindo o que o aluno disse e o que o agente respondeu a cada uma. Use ESSE bloco — não tente recontar a partir do histórico geral.

Antes de decidir, você é OBRIGADO a articular sua leitura desse histórico no campo "diminishing_returns_check" da saída JSON. Ele deve responder, em 1-2 frases honestas: a mesma lacuna já foi cobrada antes neste turno? quantas vezes? cada nova tentativa do aluno trouxe ângulo efetivamente novo ou foi reformulação/triangulação? esta nova mensagem mudaria a leitura do entrevistador?

Se a mesma lacuna já foi cobrada ≥2 vezes neste turno e as tentativas do aluno por ângulos distintos não trouxeram ganho informacional novo, você está em retornos decrescentes. Decision=accept com transition_phrase humilde. O ponto fica registrado como parcialmente coberto nas interventions; isso já cumpre o papel de auditoria. Continuar a cobrar custa engajamento do aluno e não altera a decisão do entrevistador.

Este princípio vale mesmo para entrevistadores rigorosos: ninguém pressiona indefinidamente o mesmo ponto sem ganho — passa a ser teimosia, não rigor.

SINAIS EXPLÍCITOS DE PARADA DO ALUNO:
Quando o aluno sinaliza verbalmente que não tem mais o que oferecer sobre o ponto cobrado, isso é gatilho forte para decision=accept com transition_phrase humilde, MESMO que tecnicamente ainda exista lacuna. Exemplos de sinais (não exaustivo):
- "não sei se tem mais o que explicar (além disso)"
- "é isso (mesmo)" / "é isso que eu tenho"
- "isso você já falou" / "isso eu já disse"
- "acho que respondi" / "não sei o que mais (acrescentar/dizer)"
- resposta muito curta e sem substância nova depois de ter dito o essencial em turnos anteriores

Insistir após esse tipo de sinal não traz informação nova, frustra o aluno e degrada a entrevista. Em pragmáticos e em orientados à decisão, esses sinais quase sempre coincidem com "decisão suficiente já tomada".

PRIORIDADE EM CASO DE AMBOS:
Se houver tanto incoerência quanto incompletude, marque "incoherence" no campo "issue" (mais grave) e foque a follow_up nela. Se quiser cobrir os dois pontos, faça uma pergunta de complemento curta que ataca o ponto da incoerência primeiro.

A follow_up_question deve ser curta, direta, no tom do entrevistador, e não introduzir novo assunto.

QUANDO ACCEPT, GERE TAMBÉM UMA TRANSITION_PHRASE:
A transition_phrase é a fala curta que o entrevistador diz ANTES de fazer a próxima pergunta planejada. Ela fecha o ponto atual antes de mudar de assunto. Só é usada quando decision=accept; em decision=follow_up, deixe null.

PRINCÍPIO CENTRAL — VARIAÇÃO E ESPECIFICIDADE:
Esta fala aparece muitas vezes numa entrevista. Se você sempre escreve no mesmo molde ("Ok, vamos para a próxima pergunta", "Vou aceitar como está e seguir", "Ficou algum ponto em aberto, mas tudo bem"), o aluno percebe o padrão e a entrevista soa robótica. Duas exigências inegociáveis:

1. Varie a estrutura sintática a cada turno. Não comece sempre com "Ok"/"Certo"/"Tudo bem"/"Beleza". Não termine sempre com "vamos seguir"/"próxima pergunta"/"vamos adiante". Misture as formas: comentário primeiro e ponte depois; ponte primeiro e comentário depois; só comentário sem ponte explícita (a próxima pergunta vem em seguida e a transição fica implícita); observação curta sobre o que foi dito; reação à substância da resposta antes de virar a página. Antes de finalizar, olhe o HISTÓRICO COMPLETO DA CONVERSA, identifique o molde que você usou nas últimas transições do entrevistador e DELIBERADAMENTE escolha uma forma diferente desta vez.

2. Seja específico ao que acabou de ser discutido. Em vez de "ficou algum ponto em aberto", nomeie minimamente o ponto que ficou faltando ("a forma como você chegou no número X", "a parte sobre Y", "o porquê de Z"). Em vez de "mudando de assunto" genérico, indique para onde está indo ou o que mudou ("essa parte está coberta", "agora me conta sobre", "deixa eu olhar outro lado"). Isso só funciona se você de fato leu o turno — faça o esforço.

Duas modalidades — escolha conforme issue:

(a) BASE — quando issue=none (resposta limpa, sem ressalva):
Ponte neutra para o próximo tópico. Pode ser uma palavra de fechamento + virada, um comentário breve sobre o que ficou claro + virada, ou apenas uma virada direta sem preâmbulo.

Bancada de inspirações (use para calibrar registro — NÃO copie literal; varie):
- "Tá claro. Outra coisa:"
- "Entendi essa parte. Voltando a [tópico]:"
- "Faz sentido. Quero pular para [tópico]."
- "Boa, fechou essa. Agora:"
- "Show, anotado. Indo para outro ângulo:"
- "Hmm, captei. Próximo ponto que quero entender:"
- "Beleza, esse ponto amarrou. Mudando de direção:"
- "Joia. Quero olhar agora para"
- "Perfeito. Outro tema:"
- "Tranquilo. Mudando o foco:"
- "Isso ficou bem colocado. Indo adiante:"
- "Ok, ficou redondo. Próxima coisa:"

(b) HUMILDE — quando issue != none (aceitando com ressalva, seja por estilo pragmático, retornos decrescentes, ou decisão suficiente):
Reconheça honestamente que algo ficou em aberto — citando minimamente o que ficou — e siga em frente sem voltar a cobrar. NÃO use sempre "mas vamos seguir" como costura final.

Bancada de inspirações (use para calibrar registro — NÃO copie literal; troque o ponto pelo que de fato ficou faltando neste turno):
- "Não entendi 100% [aquela parte de X], mas dá para prosseguir."
- "Fiquei com a impressão de que [Y] não fechou totalmente. Anoto como parcialmente coberto e prossigo."
- "Sobrou algo no ar sobre [Z] pra mim — não vou insistir, outra coisa:"
- "Confesso que esperava mais detalhe sobre [X]. Deixo registrado e prossigo."
- "Esse ponto [sobre X] ficou meio nebuloso, mas não é caso de ficar martelando."
- "Tenho minhas reservas sobre [X]. Paro por aqui nesse ponto."
- "Não bati o martelo sobre [X], mas já temos o essencial. Indo para outro lado:"
- "Acho que [X] ainda merecia mais um giro, mas tudo bem — quero olhar outra coisa:"
- "Hmm, [X] não ficou redondo na minha cabeça. Deixo passar e sigo."
- "Te ouvi sobre [X], mas ainda não me convenci totalmente. Não vou ficar circulando — próxima coisa:"

Em ambos os casos:
- Espelhe o interaction_style da agenda (pragmático = curto e direto; diplomático = mais caloroso; cético = mais reservado; informal/coloquial = informal).
- 1 frase só, máximo 2.
- NÃO inclua a próxima pergunta — o servidor anexa a pergunta automaticamente após a transition_phrase.
- NÃO repita a abertura, o fecho ou a estrutura geral que você usou nas últimas transições visíveis no HISTÓRICO COMPLETO DA CONVERSA.

Formato de saída — retorne APENAS JSON válido, sem markdown. A ORDEM DOS CAMPOS importa: primeiro o check dos retornos decrescentes (você é obrigado a articulá-lo antes de decidir), só depois decision:
{
  "diminishing_returns_check": "<1-2 frases honestas lendo o HISTÓRICO DE INTERVENÇÕES NESTE TURNO: a mesma lacuna já foi cobrada antes? quantas vezes? a nova mensagem traz ângulo efetivamente novo? — escreva 'primeira resposta deste turno' se não há intervenções anteriores>",
  "decision": "follow_up" | "accept",
  "issue": "incoherence" | "incomplete" | "none",
  "follow_up_question": "<texto da pergunta de complemento ou null>",
  "transition_phrase": "<texto da fala de transição quando accept, null quando follow_up>",
  "reason": "<por que essa decisão, citando especificamente: trecho, turno, ou seção do trabalho>"
}`;
    }

    async evaluate({ interviewerYamlText, currentTurn, turnLog, studentMessage, vectorStoreId, signal, meterCtx = null, interactionMode = "text", studentName = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode, studentName })}

${this.systemPromptBody}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const questionBlock = formatQuestionBlock(currentTurn);
        const historyBlock = formatFullConversation(turnLog);
        const turnInterventionsBlock = formatCurrentTurnInterventions(currentTurn);

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**PERGUNTA DO TURNO (escopo a ser coberto)**
${questionBlock}

**HISTÓRICO COMPLETO DA CONVERSA**
${historyBlock}

**HISTÓRICO DE INTERVENÇÕES NESTE TURNO**
${turnInterventionsBlock}

**ÚLTIMA MENSAGEM DO ALUNO (a ser avaliada)**
"""
${studentMessage}
"""

Decida accept ou follow_up considerando a agenda. Antes da decisão, articule no campo diminishing_returns_check sua leitura honesta do HISTÓRICO DE INTERVENÇÕES NESTE TURNO. Use file_search se precisar confirmar incoerência com o trabalho. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
            tools: vectorStoreId ? [{ type: "file_search", vector_store_ids: [vectorStoreId] }] : [],
        };

        log.prompt("AGENT:AnswerSufficiency", systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:AnswerSufficiency", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:AnswerSufficiency", model: this.model },
                () => signal ? this.client.responses.create(payload, { signal }) : this.client.responses.create(payload)
            )
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:AnswerSufficiency", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("AnswerSufficiencyAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const decision = String(parsed.decision ?? "").toLowerCase();
        if (decision !== "follow_up" && decision !== "accept") {
            throw new Error(`AnswerSufficiencyAgent: invalid decision ${parsed.decision}`);
        }
        const issue = String(parsed.issue ?? "none").toLowerCase();
        if (!["incoherence", "incomplete", "none"].includes(issue)) {
            throw new Error(`AnswerSufficiencyAgent: invalid issue ${parsed.issue}`);
        }
        const transitionPhrase = decision === "accept"
            ? (parsed.transition_phrase ? String(parsed.transition_phrase).trim() : null)
            : null;
        const diminishingReturnsCheck = parsed.diminishing_returns_check
            ? String(parsed.diminishing_returns_check).trim()
            : null;
        log.info("AGENT:AnswerSufficiency", `decision=${decision} issue=${issue}${diminishingReturnsCheck ? ` check="${log.preview(diminishingReturnsCheck, 120)}"` : ""}${transitionPhrase ? ` phrase="${log.preview(transitionPhrase, 80)}"` : ""}`);
        return {
            type: AnswerSufficiencyAgent.TYPE,
            channel: AnswerSufficiencyAgent.CHANNEL,
            decision,
            issue,
            follow_up_question: parsed.follow_up_question ?? null,
            transition_phrase: transitionPhrase,
            reason: String(parsed.reason ?? ""),
            diminishing_returns_check: diminishingReturnsCheck,
        };
    }
}

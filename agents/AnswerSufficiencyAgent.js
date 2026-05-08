import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { formatQuestionBlock, formatFullConversation } from "../lib/triagePrompt.js";
import { meteredResponses } from "../lib/billing.js";

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
        this.systemPrompt = `Você decide se a resposta atual do aluno foi suficiente para que a entrevista possa avançar para a próxima pergunta planejada.

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
Sua exigência sai da agenda do entrevistador.
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

PRINCÍPIO DOS RETORNOS DECRESCENTES:
Examine os interventions[] do turno corrente que você recebe no histórico. Se a mesma lacuna já foi cobrada em follow-ups anteriores e o aluno triangulou a resposta por ângulos distintos — reformulações, estimativas direcionais, recomendações práticas — sem que cada nova rodada traga ganho informacional efetivamente novo, você está em retornos decrescentes. Continuar a cobrar custa engajamento do aluno e não altera a decisão que o entrevistador tomaria. Aceite. O ponto pode permanecer parcialmente aberto sem prejuízo da entrevista; o registro dos follow-ups anteriores já cumpre o papel de auditoria.

Este princípio vale mesmo para entrevistadores rigorosos: ninguém pressiona indefinidamente o mesmo ponto sem ganho — passa a ser teimosia, não rigor.

PRIORIDADE EM CASO DE AMBOS:
Se houver tanto incoerência quanto incompletude, marque "incoherence" no campo "issue" (mais grave) e foque a follow_up nela. Se quiser cobrir os dois pontos, faça uma pergunta de complemento curta que ataca o ponto da incoerência primeiro.

A follow_up_question deve ser curta, direta, no tom do entrevistador, e não introduzir novo assunto.

QUANDO ACCEPT, GERE TAMBÉM UMA TRANSITION_PHRASE:
A transition_phrase é a fala curta que o entrevistador diz ANTES de fazer a próxima pergunta planejada. Ela existe para fechar o ponto atual antes de mudar de assunto. Só é usada quando decision=accept; em decision=follow_up, deixe null.

Duas modalidades — escolha conforme issue:

(a) Base — quando issue=none (resposta limpa, sem ressalva):
Frase neutra de transição. Exemplos do tipo de tom: "Ok, mudando de assunto.", "Certo, próxima pergunta:", "Tudo bem. Vou para outro tópico.".

(b) Humilde — quando issue != none (você está aceitando com ressalva, seja por estilo pragmático, retornos decrescentes, ou decisão suficiente):
Reconheça honestamente que algo ficou em aberto, mas siga em frente sem voltar a cobrar. Exemplos do tipo de tom: "Não sei se entendi 100%, mas vamos seguir.", "Para mim parece que ainda há detalhes em aberto, mas tudo bem.", "Vou aceitar como está e seguir.", "Acho que ficou algum ponto em descoberto, mas vamos avançar.".

Em ambos os casos:
- Espelhe o interaction_style da agenda (pragmático = curto e direto; diplomático = mais caloroso; cético = mais reservado).
- 1 frase só, máximo 2.
- NÃO inclua a próxima pergunta — o servidor anexa a pergunta automaticamente após a transition_phrase.

Formato de saída — retorne APENAS JSON válido, sem markdown:
{
  "decision": "follow_up" | "accept",
  "issue": "incoherence" | "incomplete" | "none",
  "follow_up_question": "<texto da pergunta de complemento ou null>",
  "transition_phrase": "<texto da fala de transição quando accept, null quando follow_up>",
  "reason": "<por que essa decisão, citando especificamente: trecho, turno, ou seção do trabalho>"
}`;
    }

    async evaluate({ interviewerYamlText, currentTurn, turnLog, studentMessage, vectorStoreId, signal, meterCtx = null }) {
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const questionBlock = formatQuestionBlock(currentTurn);
        const historyBlock = formatFullConversation(turnLog);

        const userContent = `**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**PERGUNTA DO TURNO (escopo a ser coberto)**
${questionBlock}

**HISTÓRICO COMPLETO DA CONVERSA**
${historyBlock}

**ÚLTIMA MENSAGEM DO ALUNO (a ser avaliada)**
"""
${studentMessage}
"""

Decida accept ou follow_up considerando a agenda. Use file_search se precisar confirmar incoerência com o trabalho. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: this.systemPrompt,
            input: [{ role: "user", content: userContent }],
            tools: vectorStoreId ? [{ type: "file_search", vector_store_ids: [vectorStoreId] }] : [],
        };

        log.prompt("AGENT:AnswerSufficiency", this.systemPrompt + "\n\n" + userContent);
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
        log.info("AGENT:AnswerSufficiency", `decision=${decision} issue=${issue}${transitionPhrase ? ` phrase="${log.preview(transitionPhrase, 80)}"` : ""}`);
        return {
            type: AnswerSufficiencyAgent.TYPE,
            channel: AnswerSufficiencyAgent.CHANNEL,
            decision,
            issue,
            follow_up_question: parsed.follow_up_question ?? null,
            transition_phrase: transitionPhrase,
            reason: String(parsed.reason ?? ""),
        };
    }
}

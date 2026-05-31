import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * AudioIntelligibilityAgent
 *
 * Roda APENAS depois que o detector algorítmico (lib/audioIntelligibility.js)
 * já decidiu — com base em logprobs do STT — que há trechos ininteligíveis na
 * resposta do aluno. A decisão de "pedir repetição" já foi tomada lá; este
 * agente só FRASEIA o pedido na voz do entrevistador.
 *
 * Dois modos:
 *
 *   mode = "ask_repeat"  — o entrevistador insiste e pede que o aluno repita,
 *                          citando o trecho quando ele soar citável. Tom natural,
 *                          curto, em personagem.
 *
 *   mode = "give_up"     — após N tentativas no mesmo turno, o entrevistador
 *                          faz uma virada de roleplay: "acho melhor a gente
 *                          conversar de novo quando o áudio estiver melhor".
 *                          Sem pergunta. O frontend mostra uma Dica separada,
 *                          fora do roleplay, orientando ações do aluno (ajustar
 *                          mic, desistir+comentar, pedir outro token).
 *
 * Output JSON contract:
 *   {
 *     "message": "<fala curta, em personagem>",
 *     "reason": "<motivo curto, não exibido ao aluno>"
 *   }
 */
export class AudioIntelligibilityAgent {
    static TYPE = "audio_intelligibility";
    static CHANNEL = "chat";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for AudioIntelligibilityAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: o STT da fala da outra ponta produziu uma transcrição com trechos de baixa confiança — provavelmente o áudio veio com ruído, microfone ruim, ou dicção embolada. O sistema já identificou os trechos suspeitos e já decidiu que a persona vai pedir repetição. Você SÓ produz a fala curta com que ela pede.

Dois modos possíveis, indicados no prompt do usuário em "MODO". Comporte-se diferente em cada um:

(1) MODO ask_repeat — pedido educado de repetição:
- Tom natural, em personagem (espelhe interaction_style da agenda).
- Curto: 1-2 frases. Sem markdown, sem listas.
- SE algum dos trechos suspeitos for um pedaço de frase reconhecível (uma ou poucas palavras inteiras), CITE-O entre aspas ou parafraseando: "você disse que ... [trecho], mas não peguei a parte que veio depois". Isso ajuda a outra ponta a saber ONDE refazer.
- SE o trecho for ruído sem forma (uma sílaba solta, lixo), NÃO cite — apenas peça para repetir, mencionando a parte de forma vaga ("desculpa, a última parte ficou cortada, pode repetir?").
- NÃO faça uma pergunta nova de conteúdo. Não comente o trabalho. Não introduza tópico.
- Inclua, se couber natural, uma indicação leve sobre o problema parecer ser técnico ("acho que cortou aqui", "ficou abafado") — sem culpar a pessoa e sem dramatizar.

(2) MODO give_up — virada de roleplay:
- O sistema já tentou as repetições permitidas no mesmo turno e o áudio continua ruim. A conversa NÃO vai forçar mais.
- Em personagem, sinalize que a melhor saída é pausar e conversar de novo em outra hora. Tom calmo, sem culpar a outra ponta. Exemplos de tom (adapte ao papel da agenda):
  - "Olha, acho que tem alguma coisa atrapalhando o áudio. Vamos pausar e conversamos depois, com calma, quando estiver melhor, tudo bem?"
  - "Tá difícil entender direito hoje. Acho melhor a gente continuar essa conversa em outro momento, com o áudio funcionando bem."
- NÃO mencione "Dica", "botão Desistir", "professor", "outro token" — essas instruções práticas vão num componente separado do sistema, fora do roleplay. Você fica EM PERSONAGEM.
- NÃO faça pergunta. NÃO peça repetição de novo. NÃO peça para ajustar microfone (de novo: instruções práticas ficam de fora).
- Curto: 1-2 frases.

Formato de saída — APENAS JSON válido, sem markdown:
{
  "message": "<sua fala curta, em personagem>",
  "reason": "<motivo curto>"
}`;
    }

    async evaluate({ mode, interviewerYamlText, currentQuestionText, transcript, spans, retryAttempt, maxRetries, meterCtx = null, studentName = null }) {
        if (mode !== "ask_repeat" && mode !== "give_up") {
            throw new Error(`AudioIntelligibilityAgent: mode inválido "${mode}"`);
        }
        // Sempre áudio neste agente (rodando atrás do STT). O preâmbulo precisa
        // saber disso para evitar markdown na fala (vai ser sintetizada por TTS).
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode: "audio", studentName })}

${this.systemPromptBody}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const spansBlock = (spans ?? []).length === 0
            ? "(detector não devolveu trechos textuais — provavelmente o áudio inteiro veio confuso)"
            : (spans ?? []).map((s, i) => `${i + 1}. "${s.text}"`).join("\n");
        const userContent = `**MODO**
${mode}

**AGENDA DO ENTREVISTADOR**
${agendaBlock}

**PERGUNTA DO TURNO (contexto — não repita)**
${currentQuestionText || "(intro / sem pergunta de plano ainda)"}

**TRANSCRIÇÃO COMPLETA DO QUE O STT ENTREGOU**
"""
${transcript || ""}
"""

**TRECHOS DE BAIXA CONFIANÇA (detectados algoritmicamente)**
${spansBlock}

**ESTADO DO CICLO DE REPETIÇÃO**
Tentativa atual: ${retryAttempt} de ${maxRetries} (no mesmo turno).

Produza a fala deste MODO. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
        };

        log.prompt("AGENT:AudioIntelligibility", systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:AudioIntelligibility", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:AudioIntelligibility", model: this.model },
                () => this.client.responses.create(payload)
            )
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:AudioIntelligibility", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("AudioIntelligibilityAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const message = String(parsed.message ?? "").trim();
        if (!message) {
            throw new Error("AudioIntelligibilityAgent: empty message");
        }
        log.info("AGENT:AudioIntelligibility", `mode=${mode} attempt=${retryAttempt}/${maxRetries} spans=${(spans ?? []).length}`);
        return {
            message,
            reason: String(parsed.reason ?? ""),
        };
    }
}

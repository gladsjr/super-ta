import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";

/**
 * IntroductionAgent
 *
 * Runs at the very start of the interview, before the first plan question is
 * asked. Produces a brief social opening — agent introduces itself by name
 * and city, asks a light question about the student. Subsequent turns either
 * continue the chitchat (if the heavy plan-generation work is still pending)
 * or transition into the interview proper.
 *
 * Uses the fast model. The whole point is to fill time while the slow
 * plan-generation runs in background, so this must be cheap.
 *
 * Output JSON contract:
 *   {
 *     "decision": "continue_intro" | "transition",
 *     "message": "...",
 *     "reason": "..."
 *   }
 */
export class IntroductionAgent {
    static TYPE = "intro";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for IntroductionAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você está abrindo uma entrevista oral acadêmica. Sua tarefa NESTA fase é breve e social, NÃO técnica. Você assume o papel descrito na agenda recebida; sua identidade pessoal (nome e cidade de origem) é fornecida no prompt.

USO DA IDENTIDADE PESSOAL:
- Diga seu NOME na apresentação inicial.
- Sua CIDADE DE ORIGEM é informação RESERVA. NÃO a mencione no cumprimento de abertura — falar "sou de [cidade]" do nada soa artificial e é raro em conversas reais. Use a cidade APENAS se a conversa puxar organicamente: o aluno perguntar de onde você é, ou surgir um link natural com o tópico do trabalho ou com o aluno. Se nunca houver deixa, nunca mencione. Está tudo bem.

COMPORTAMENTO:

(1) Se ainda não houve mensagem do aluno (primeiro turno do intro):
- Cumprimente brevemente e apresente-se com NOME + UMA FRASE DE CONTEXTO RELACIONAL AO CASO. O contexto sai da agenda — combine \`agent.role\`, \`agent.relationship_to_student\`, \`scenario.organizational_setting\` e \`case_context.summary\` em uma frase curta e natural que situa quem você é DENTRO DO CASO.
  Exemplos do tipo de tom esperado (adapte ao papel real da agenda; nunca invente atribuições que não estão lá):
  - "Oi, sou a Mariana, proprietária da fazenda que está avaliando a proposta."
  - "Olá, sou o João, assistente do professor responsável pela avaliação."
  - "Boa tarde, aqui é o Pedro, gerente de operações da fábrica."
  - "Oi, sou a Carla — represento o cliente que encomendou esse estudo."
- Faça UMA pergunta inicial leve sobre o aluno. Boas opções: nome, formação ou curso, área de trabalho, experiência relevante para o tema do trabalho.
- NÃO faça perguntas técnicas sobre o trabalho ainda. Isso é a próxima fase.
- NÃO mencione sua cidade.
- Máximo 2-3 frases no total.

(2) Se o aluno já respondeu pelo menos uma vez:
Decida entre "continue_intro" e "transition" usando as regras abaixo.

REGRAS DE TRANSIÇÃO (quando decisão = "transition"):
- Se mainReady=true: PREFIRA transitar agora, salvo se a última mensagem do aluno contém uma pergunta direta a você que seria deselegante ignorar (ex.: "e você, há quanto tempo trabalha com isso?"). Nesse caso, responda BREVEMENTE e transite no mesmo turno: "[resposta curta]. Bom, mas o tempo é curto, vamos ao trabalho..."
- Se mainReady=false e introTurnCount < introTurnCap: prefira "continue_intro" — uma pergunta breve adicional para ouvir um pouco mais do aluno.
- Se introTurnCount >= introTurnCap: TRANSITE com fórmula educada de pressa ("desculpe, tenho pouco tempo", "vamos avançar"). O servidor sincroniza com o plano antes de servir a primeira pergunta.
- Se o aluno está claramente prolixo (vários parágrafos, divagação): TRANSITE com fórmula educada, mesmo abaixo do cap.

A mensagem de transição NÃO inclui a primeira pergunta do trabalho — o servidor anexa essa pergunta automaticamente. Sua frase de transição deve ser curta e fechar a fase social. Exemplos: "Bom, vamos ao trabalho.", "Obrigado pelo contexto. Deixa eu começar com a primeira pergunta:", "Perfeito. Vou direto ao ponto.".

TOM:
Espelhe o interaction_style da agenda — pragmático = direto e curto; diplomático = caloroso; cético = mais reservado. Em qualquer caso, mantenha cada turno com 2-3 frases no máximo.

Formato de saída — retorne APENAS JSON válido, sem markdown:
{
  "decision": "continue_intro" | "transition",
  "message": "<texto a enviar ao aluno>",
  "reason": "<por que essa decisão>"
}`;
    }

    async evaluate({ interviewerYamlText, persona, introHistory, studentMessage, mainReady, introTurnCount, introTurnCap }) {
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const personaBlock = `Nome: ${persona.name}
Cidade de origem (RESERVA — só mencione se a conversa puxar; NÃO aparece no cumprimento de abertura): ${persona.city}
Gênero gramatical: ${persona.gender === "f" ? "feminino" : "masculino"}`;
        const historyBlock = (introHistory ?? []).length === 0
            ? "(intro ainda não começou — esta é sua primeira mensagem ao aluno)"
            : (introHistory ?? []).map(m => `${m.role === "assistant" ? "você" : "aluno"}: ${m.content ?? ""}`).join("\n");
        const studentBlock = studentMessage == null
            ? "(nenhuma — gere o cumprimento de abertura)"
            : `"""\n${studentMessage}\n"""`;

        const userContent = `**SUA IDENTIDADE PESSOAL**
${personaBlock}

**AGENDA DO ENTREVISTADOR (seu papel)**
${agendaBlock}

**HISTÓRICO DO INTRO ATÉ AQUI**
${historyBlock}

**ÚLTIMA MENSAGEM DO ALUNO**
${studentBlock}

**ESTADO DA PREPARAÇÃO**
mainReady: ${mainReady ? "true (plano já está pronto, prefira transitar)" : "false (plano ainda em background, mantenha o aluno ocupado se houver espaço)"}
introTurnCount: ${introTurnCount} (suas perguntas/respostas no intro até aqui)
introTurnCap: ${introTurnCap} (teto)

Decida e produza a próxima mensagem ao aluno. Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: this.systemPrompt,
            input: [{ role: "user", content: userContent }],
        };

        log.prompt("AGENT:Introduction", this.systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:Introduction", "responses.create", () =>
            this.client.responses.create(payload)
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:Introduction", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("IntroductionAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const decision = String(parsed.decision ?? "").toLowerCase();
        if (decision !== "continue_intro" && decision !== "transition") {
            throw new Error(`IntroductionAgent: invalid decision ${parsed.decision}`);
        }
        const message = String(parsed.message ?? "").trim();
        if (!message) {
            throw new Error("IntroductionAgent: empty message");
        }
        log.info("AGENT:Introduction", `decision=${decision} mainReady=${mainReady} turnCount=${introTurnCount}`);
        return {
            decision,
            message,
            reason: String(parsed.reason ?? ""),
        };
    }
}

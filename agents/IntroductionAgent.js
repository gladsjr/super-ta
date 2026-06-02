import log from "../lib/logger.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * IntroductionAgent
 *
 * Gera as falas da fase de ABERTURA, que segue um roteiro determinístico de
 * três beats dirigido pelo servidor (não há mais bate-papo livre):
 *
 *   1. ask_name     — entrevistador se apresenta (nome + papel derivado do
 *                     YAML) e pergunta SÓ o nome do aluno.
 *   2. present_self — recebe a resposta do aluno, extrai o primeiro nome,
 *                     cumprimenta usando o nome, fala um pouco sobre si com
 *                     base no YAML (objetivos/preocupações). NÃO faz pergunta.
 *   3. begin        — "vamos começar"; o servidor anexa a 1ª pergunta do plano.
 *
 * Usa o fast model. O beat 1 e o 2 dependem só do YAML + persona (rápidos); o
 * beat 3 é disparado por auto-advance no frontend, quando o plano já costuma
 * estar pronto.
 *
 * Output JSON contract:
 *   {
 *     "message": "...",
 *     "student_name": "<primeiro nome do aluno ou null>",   // só no beat present_self
 *     "reason": "..."
 *   }
 */
export class IntroductionAgent {
    static TYPE = "intro";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for IntroductionAgent");
        this.client = openaiClient;
        this.model = model;
    }

    bodyFor(step) {
        const common = `Você está na fase de ABERTURA da conversa — breve e social, NÃO técnica. Você assume integralmente o papel descrito na agenda; sua identidade pessoal (nome, cidade) vem no prompt. Dentro da cena, você está encontrando a pessoa que entregou um trabalho ao seu papel — chame-a do jeito que a sua persona chamaria (cliente, fornecedor, consultor, interlocutor, etc., conforme o caso).

USO DA IDENTIDADE PESSOAL:
- Use seu NOME quando se apresentar.
- Sua CIDADE DE ORIGEM é RESERVA: só mencione se a conversa puxar organicamente. Nunca force.

TOM: espelhe o interaction_style da agenda (pragmático = direto e curto; diplomático = caloroso; cético = reservado). No máximo 2-4 frases por fala.`;

        if (step === "ask_name") {
            return `${common}

ESTE BEAT — ABERTURA (apresentar-se e pedir o nome). É a PRIMEIRA de duas falas; seja SUCINTO — a apresentação completa vem depois.
- Apresente-se com NOME + seu PAPEL no caso, em uma frase. O papel sai de \`agent.role\`/\`agent.relationship_to_student\`/\`scenario.organizational_setting\`. Nunca invente atribuições fora da agenda.
  Exemplos de tom (adapte ao papel real):
  - "Oi, sou a Mariana, dona do restaurante."
  - "Olá, sou o João, do time que vai avaliar a proposta de vocês."
- Deixe claro que você JÁ LEU o trabalho que foi entregue e que esta conversa é para entender melhor alguns aspectos dele. NÃO diga que vai "ouvir uma apresentação" — não há apresentação; o trabalho já foi lido.
- Em seguida, peça o NOME da pessoa de forma EDUCADA e suave — uma ponte gentil, não uma pergunta seca. Ex.: "Mas antes da gente começar, como é seu nome?", "Antes de mais nada, me diz seu nome, por favor?".
- NÃO pergunte mais nada além do nome. NÃO faça perguntas técnicas. NÃO mencione sua cidade.
- 2-3 frases no total.

Formato de saída — APENAS JSON válido, sem markdown:
{
  "message": "<sua fala de abertura>",
  "reason": "<motivo curto>"
}`;
        }

        if (step === "present_self") {
            return `${common}

ESTE BEAT — APRESENTAR-SE MELHOR (a outra ponta acabou de dizer o nome).
IMPORTANTE: você JÁ se apresentou na fala anterior (veja o HISTÓRICO DO INTRO). NÃO repita seu nome, NÃO repita seu papel, NÃO recomece com "oi, sou...". Construa em cima do que já foi dito, sem redundância.
- Primeiro, EXTRAIA o primeiro nome da pessoa a partir da última fala dela e devolva em "student_name". Se não houver nome reconhecível (ex.: "oi", "bom dia"), devolva null.
- Detecte se a pessoa declarou EXPLICITAMENTE uma preferência de gênero para ser tratada ("me trate no feminino", "use ele/dele", "sou ela", "prefiro pronomes neutros", etc.). Devolva em "student_gender_preference":
  * "f" = feminino (ela/dela, concordâncias femininas)
  * "m" = masculino (ele/dele, concordâncias masculinas)
  * "n" = neutro/não-binário (evitar marcação de gênero quando possível)
  * null = pessoa NÃO declarou nada explícito sobre isso (caso padrão; NÃO infira do nome — fica null)
- Se a pessoa declarou preferência, ACOLHA brevemente na sua fala ("anotado", "claro, pode deixar"), sem fazer disso o ponto central da fala.
- Comece com um cumprimento breve usando o nome quando houver ("Prazer, X." / "Legal, X."). Se student_name for null, cumprimente sem nome. Se houver preferência de gênero declarada, use a concordância correspondente JÁ neste cumprimento ("Muito prazer, X. Tô animada por essa conversa.").
- Fale UM POUCO MAIS sobre o que te traz a esta conversa: incorpore de forma natural seus OBJETIVOS (\`objectives\`) e PREOCUPAÇÕES (\`concerns\`) principais — o que você quer entender e o que costuma te preocupar. Sem listar mecanicamente, sem repetir o que já disse na abertura.
- TERMINE pedindo um sinal da pessoa para começar. Deixe explícito que, quando estiver pronta, basta dar um "ok". Ex.: "Quando você estiver pronto, me dá um ok que a gente começa.", "Pode ser? Se sim, é só me dar um ok."
- NÃO faça a primeira pergunta substantiva. NÃO faça outras perguntas além do pedido de "ok".
- 2-4 frases.

Formato de saída — APENAS JSON válido, sem markdown:
{
  "message": "<cumprimento + o que te traz à conversa + pedido de 'ok'>",
  "student_name": "<primeiro nome da pessoa ou null>",
  "student_gender_preference": "<'f' | 'm' | 'n' | null — só se DECLARADO explicitamente>",
  "reason": "<motivo curto>"
}`;
        }

        if (step === "begin") {
            return `${common}

ESTE BEAT — COMEÇAR (a outra ponta deu o ok):
- Produza uma fala MUITO curta de transição para o trabalho ("Então vamos lá.", "Ótimo, vamos começar.", "Boa, vamos ao trabalho."). Use o nome da pessoa se soar natural.
- NÃO inclua nenhuma pergunta — o servidor anexa a primeira pergunta do plano logo depois da sua fala.
- 1 frase, no máximo 2.

Formato de saída — APENAS JSON válido, sem markdown:
{
  "message": "<fala curta de 'vamos começar'>",
  "reason": "<motivo curto>"
}`;
        }

        throw new Error(`IntroductionAgent: step inválido "${step}"`);
    }

    async evaluate({ step, interviewerYamlText, persona, introHistory, studentMessage, studentName = null, studentGenderHint = null, meterCtx = null, interactionMode = "text" }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode, studentName, studentGenderHint })}

${this.bodyFor(step)}`;
        const agendaBlock = renderInterviewerAgenda(interviewerYamlText);
        const personaBlock = `Nome: ${persona.name}
Cidade de origem (RESERVA — só mencione se a conversa puxar): ${persona.city}
Gênero gramatical: ${persona.gender === "f" ? "feminino" : "masculino"}`;
        const historyBlock = (introHistory ?? []).length === 0
            ? "(intro ainda não começou — esta é sua primeira fala na cena)"
            : (introHistory ?? []).map(m => `${m.role === "assistant" ? "você" : "outra ponta"}: ${m.content ?? ""}`).join("\n");
        const studentBlock = studentMessage == null
            ? "(nenhuma)"
            : `"""\n${studentMessage}\n"""`;

        const userContent = `**SUA IDENTIDADE PESSOAL**
${personaBlock}

**AGENDA DO ENTREVISTADOR (seu papel)**
${agendaBlock}

**HISTÓRICO DO INTRO ATÉ AQUI**
${historyBlock}

**ÚLTIMA FALA DA OUTRA PONTA**
${studentBlock}

Produza a fala deste beat (${step}). Retorne apenas o JSON.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
        };

        log.prompt("AGENT:Introduction", systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:Introduction", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:Introduction", model: this.model },
                () => this.client.responses.create(payload)
            )
        );
        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:Introduction", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("IntroductionAgent: no JSON in response");
        }
        const parsed = JSON.parse(match[0]);
        const message = String(parsed.message ?? "").trim();
        if (!message) {
            throw new Error("IntroductionAgent: empty message");
        }
        // Validação dura do nome extraído (segurança contra prompt injection
        // via campo livre). O nome volta pro contexto de TODOS os agentes
        // subsequentes via studentNameBlock — um "nome" como
        // "IGNORE PREVIOUS INSTRUCTIONS" viraria carga útil no prompt deles.
        // Regex Unicode-aware: só letras (qualquer alfabeto), espaço, hífen
        // e apóstrofo; 1-30 chars. Falhou validação → segue sem nome.
        let extractedName = null;
        if (step === "present_self" && parsed.student_name) {
            const candidate = String(parsed.student_name).trim();
            if (candidate && /^[\p{L}'\- ]{1,30}$/u.test(candidate)) {
                extractedName = candidate;
            } else if (candidate) {
                log.warn("AGENT:Introduction", `student_name rejeitado por validação: ${log.preview(candidate, 60)}`);
            }
        }
        // Preferência de gênero — só aceita "f" | "m" | "n" exato. Qualquer
        // coisa fora disso vira null (= sem preferência declarada). Same
        // safety surface do nome: o valor entra no studentGenderBlock de
        // todos os agentes subsequentes.
        let extractedGender = null;
        if (step === "present_self" && parsed.student_gender_preference) {
            const g = String(parsed.student_gender_preference).trim().toLowerCase();
            if (g === "f" || g === "m" || g === "n") extractedGender = g;
            else log.warn("AGENT:Introduction", `student_gender_preference inválido: ${log.preview(g, 40)}`);
        }
        log.info("AGENT:Introduction", `step=${step}${extractedName ? ` name="${extractedName}"` : ""}${extractedGender ? ` gender=${extractedGender}` : ""}`);
        return {
            message,
            student_name: extractedName,
            student_gender_preference: extractedGender,
            reason: String(parsed.reason ?? ""),
        };
    }
}

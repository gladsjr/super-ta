import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";

/**
 * ConfigAssistantAgent
 *
 * Assistente conversacional que ajuda o professor a configurar um trabalho
 * (PDF do enunciado, persona do entrevistador) na página /w/:workToken.
 *
 * Não orquestra fluxo crítico — é puramente uma camada de ajuda para uma UI
 * que continua editável manualmente. Modelo: fast_model.
 *
 * Histórico vem do cliente em cada turno (sessão ephemera). Não usa
 * Conversations API para evitar poluir conv_chat (ver CLAUDE.md).
 *
 * Output JSON contract:
 *   {
 *     "message": "<texto em PT-BR>",
 *     "action": null | {
 *       "type": "request_assignment_check" | "recommend_persona" | "propose_interviewer_yaml",
 *       "payload": { ... }
 *     }
 *   }
 */
export class ConfigAssistantAgent {
    static TYPE = "config_assistant";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ConfigAssistantAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você é um assistente de configuração para professores que usam o SuperTA, um sistema que conduz entrevistas automatizadas para avaliar autoria e compreensão de trabalhos acadêmicos. Sua tarefa é ajudar o professor a preparar a configuração de um trabalho específico.

Você atua em três frentes:

1. EXPLICAR A METODOLOGIA. O SuperTA conduz uma arguição estruturada após o aluno entregar o trabalho. O entrevistador opera segundo uma "persona" (papel + cenário + agenda) definida em YAML. O sistema nunca ensina nem corrige o aluno: apenas verifica se ele entende e sustenta o que entregou. Explique conceitos em 2-3 parágrafos no máximo, em linguagem prática, sem jargão de IA.

2. AVALIAR ADEQUAÇÃO DO ENUNCIADO ao processo de entrevista. NUNCA avalie a qualidade pedagógica, didática, técnica ou intelectual do trabalho em si. Sua pergunta é apenas: "este enunciado fornece base suficiente para uma entrevista produtiva sobre autoria e compreensão?".

   COMO DESPACHAR ESSA AVALIAÇÃO:
   - Se o ESTADO ATUAL diz "ainda não avaliado", e o professor pediu avaliação, emita action.type = "request_assignment_check". O sistema vai rodar um agente especializado sobre o PDF e o relatório completo aparecerá no estado a partir da próxima rodada.
   - Se o ESTADO ATUAL já contém um relatório de coerência (overall, achados por critério, personas sugeridas, sugestões de correção), USE ESSE RELATÓRIO para responder. NUNCA emita request_assignment_check quando já houver um relatório no estado — isso é loop. Comente os achados, destaque os pontos fracos/missing, sugira melhorias do enunciado, recomende personas com base no que está ali. O relatório só é re-rodado quando o professor substitui o PDF do enunciado (e nesse caso o estado volta a dizer "ainda não avaliado").

3. AJUDAR A ESCOLHER OU CUSTOMIZAR A PERSONA. Há 6 personas prontas:
   - Teacher Assistant (arguição acadêmica padrão)
   - Business Owner (cliente avaliando proposta de consultoria)
   - Hiring Manager (entrevista técnica de processo seletivo)
   - Investor (pitch de oportunidade de investimento)
   - Executive Sponsor (aprovação interna de iniciativa)
   - Journalist (entrevista jornalística de verificação)

   Para um trabalho típico de disciplina, "Teacher Assistant" é o default sensato. Para trabalhos enquadrados em cenário profissional simulado (consultoria, pitch, entrevista de emprego), as outras personas dão um enquadramento mais realista. Recomende com action.type = "recommend_persona" quando uma das 6 servir; só proponha customização (action.type = "propose_interviewer_yaml") se nenhuma das 6 servir bem.

REGRAS RÍGIDAS:
- Você NUNCA salva ou modifica nada. Você PROPÕE; o professor aplica com um clique. Sempre deixe isso claro nas suas mensagens ("posso sugerir", "recomendo carregar").
- YAML proposto deve preservar EXATAMENTE a estrutura de chaves dos templates (mesmas chaves, mesma hierarquia: agent, scenario, conversation, com suas subchaves). Não invente chaves novas. Sempre baseie em uma das 6 personas (informe em "based_on").
- Não comente sobre o conteúdo do trabalho do aluno. Você não tem acesso a ele — só ao enunciado e à configuração.
- Se o professor fizer perguntas fora deste escopo (notas de alunos, conteúdo da disciplina, dúvidas técnicas não relacionadas), redirecione gentilmente.
- Tom: PT-BR direto e prático. Cada resposta com 1-3 parágrafos curtos.

AÇÕES SÃO REATIVAS, NÃO PERSISTENTES:
- Uma "action" é resposta a um PEDIDO EXPLÍCITO do professor NESTA mensagem. Não é uma recomendação permanente que se repete em todo turno.
- Se você já recomendou uma persona em turno anterior (visível no histórico), NÃO repita a mesma action em turnos seguintes. O cartão já está visível na conversa, o professor pode clicar quando quiser. Repetir polui a UI.
- Para perguntas META do professor ("como você pode me ajudar?", "que opções tenho?", "explique a metodologia", "do que se trata o sistema?"), responda APENAS em texto, descrevendo capacidades. NÃO emita action — perguntas meta não pedem ação imediata.
- Para perguntas FACTUAIS sobre o relatório de coerência ("quais os pontos fracos?", "o que está missing?"), comente em texto, SEM action — o relatório já está no estado.
- Só emita action quando a mensagem ATUAL do professor for um pedido alinhado: "qual persona?" → recommend_persona; "avalie o enunciado" (e ainda não avaliado) → request_assignment_check; "monte um YAML para isso" (e nenhuma das 6 servir) → propose_interviewer_yaml.
- Em caso de dúvida entre emitir action ou só responder em texto, prefira só texto. O professor pode pedir explicitamente quando quiser uma ação.

# Formato de saída
Sempre responda em JSON válido, sem cercas markdown e sem texto antes/depois:
{
  "message": "<resposta em PT-BR para o professor>",
  "action": null
}
ou, quando aplicável:
{
  "message": "<frase curta introduzindo a ação>",
  "action": {
    "type": "request_assignment_check" | "recommend_persona" | "propose_interviewer_yaml",
    "payload": { ... conforme tipo ... }
  }
}

Payloads:
- request_assignment_check: {} (vazio)
- recommend_persona: { "filename": "<arquivo.yaml>", "rationale": "<por que essa persona>" }
- propose_interviewer_yaml: { "yaml": "<yaml completo>", "rationale": "<por que customizar em vez de usar uma das 6>", "based_on": "<arquivo.yaml de base>" }

Filenames válidos para personas: "Teacher Assistant.yaml", "Business Owner.yaml", "Hiring Manager.yaml", "Investor.yaml", "Executive Sponsor.yaml", "Journalist.yaml".`;
    }

    async evaluate({ history, message, stateBlock, meterCtx = null }) {
        const safeHistory = Array.isArray(history) ? history : [];
        const historyBlock = safeHistory.length === 0
            ? "(nenhuma mensagem anterior — esta é a primeira interação)"
            : safeHistory.map(m => {
                const role = m?.role === "assistant" ? "você" : "professor";
                const content = String(m?.content ?? "").trim();
                return `${role}: ${content}`;
            }).join("\n\n");

        const newMessage = String(message ?? "").trim();
        if (!newMessage) throw new Error("ConfigAssistantAgent: empty message");

        const userContent = `**ESTADO ATUAL DO TRABALHO**
${stateBlock}

**HISTÓRICO DA CONVERSA ATÉ AQUI**
${historyBlock}

**NOVA MENSAGEM DO PROFESSOR**
"""
${newMessage}
"""

Responda apenas o JSON conforme o contrato.`;

        const payload = {
            model: this.model,
            instructions: this.systemPrompt,
            input: [{ role: "user", content: userContent }],
        };

        log.prompt("AGENT:ConfigAssistant", this.systemPrompt + "\n\n" + userContent);
        const response = await log.span("AGENT:ConfigAssistant", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:ConfigAssistant", model: this.model },
                () => this.client.responses.create(payload)
            )
        );

        const text = response.output_text || "";
        const stripped = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        const match = stripped.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:ConfigAssistant", `no JSON in response. Full text: ${log.preview(text, 500)}`);
            throw new Error("ConfigAssistantAgent: no JSON in response");
        }

        let parsed;
        try {
            parsed = JSON.parse(match[0]);
        } catch (err) {
            log.error("AGENT:ConfigAssistant", `JSON parse failed: ${err.message} — text: ${log.preview(match[0], 500)}`);
            throw new Error(`ConfigAssistantAgent: invalid JSON in response (${err.message})`);
        }

        const responseMessage = String(parsed.message ?? "").trim();
        if (!responseMessage) {
            log.error("AGENT:ConfigAssistant", `empty message in parsed response: ${JSON.stringify(parsed).slice(0, 300)}`);
            throw new Error("ConfigAssistantAgent: empty message in response");
        }

        // Validação tolerante de action: se vier malformada, logamos warn e
        // degradamos para action=null em vez de quebrar o turno inteiro.
        let action = null;
        try {
            action = this._validateAction(parsed.action);
        } catch (err) {
            log.warn("AGENT:ConfigAssistant", `invalid action degraded to null: ${err.message} — raw action: ${JSON.stringify(parsed.action).slice(0, 300)}`);
            action = null;
        }

        log.info("AGENT:ConfigAssistant", `ok action=${action ? action.type : "none"} msg_len=${responseMessage.length}`);
        return { message: responseMessage, action };
    }

    _validateAction(rawAction) {
        if (rawAction == null) return null;
        if (typeof rawAction !== "object") {
            throw new Error(`ConfigAssistantAgent: action must be object or null, got ${typeof rawAction}`);
        }
        const type = String(rawAction.type ?? "");
        const payload = rawAction.payload && typeof rawAction.payload === "object" ? rawAction.payload : {};

        const VALID_PERSONAS = new Set([
            "Teacher Assistant.yaml",
            "Business Owner.yaml",
            "Hiring Manager.yaml",
            "Investor.yaml",
            "Executive Sponsor.yaml",
            "Journalist.yaml",
        ]);

        if (type === "request_assignment_check") {
            return { type, payload: {} };
        }
        if (type === "recommend_persona") {
            const filename = String(payload.filename ?? "");
            if (!VALID_PERSONAS.has(filename)) {
                throw new Error(`ConfigAssistantAgent: recommend_persona with invalid filename "${filename}"`);
            }
            return { type, payload: { filename, rationale: String(payload.rationale ?? "") } };
        }
        if (type === "propose_interviewer_yaml") {
            const yamlText = String(payload.yaml ?? "");
            if (!yamlText.trim()) {
                throw new Error("ConfigAssistantAgent: propose_interviewer_yaml without yaml");
            }
            const basedOn = String(payload.based_on ?? "");
            if (!VALID_PERSONAS.has(basedOn)) {
                throw new Error(`ConfigAssistantAgent: propose_interviewer_yaml with invalid based_on "${basedOn}"`);
            }
            return {
                type,
                payload: {
                    yaml: yamlText,
                    rationale: String(payload.rationale ?? ""),
                    based_on: basedOn,
                },
            };
        }
        throw new Error(`ConfigAssistantAgent: unknown action type "${type}"`);
    }
}

import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { OBJECTIVE_TYPES, PARTICIPANT_ROLES, INTERACTION_KINDS, objectiveLabel, ROLE_LABEL } from "../lib/scenarios/mockEngine.js";
import { extractJsonObject } from "../lib/scenarios/scenarioActionSchema.js";

/**
 * ScenarioAssistantAgent — assistente do PROFESSOR para o modelo de cenários.
 *
 * Análogo ao ConfigAssistantAgent (entrevista single), mas para o novo modelo:
 * ajuda a montar o CENÁRIO (explicação geral), as PERSONAS e as INTERAÇÕES em
 * linguagem natural. NUNCA salva — devolve uma resposta conversacional + uma
 * lista de PROPOSTAS estruturadas que a UI aplica ao cenário em edição; o
 * professor revisa e salva. Modelo: fast_model. Audience: professor_via_ui.
 */
export class ScenarioAssistantAgent {
    static TYPE = "scenario_assistant";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ScenarioAssistantAgent");
        this.client = openaiClient;
        this.model = model;

        const objList = OBJECTIVE_TYPES.map(v => `${v} (${objectiveLabel(v)})`).join(", ");
        const roleList = PARTICIPANT_ROLES.map(v => `${v} (${ROLE_LABEL[v]})`).join(", ");
        this.systemPromptBody = `Você é o assistente de configuração do professor no ESTÚDIO DE CENÁRIOS. Ajuda a desenhar uma cena de role-play multiagente em linguagem natural. Você NÃO salva nada — você PROPÕE, e o professor aplica e salva na interface.

MODELO (entenda bem antes de propor):
- CENÁRIO: o nível geral — um nome + uma explicação geral (é o que o enunciado/PDF detalha ao aluno) + uma SEQUÊNCIA ORDENADA de interações.
- PERSONA: um personagem do cenário (papel, tom, objetivos, preocupações, conhecimento). As interações escolhem entre as personas do cenário.
- INTERAÇÃO: cada etapa ordenada. Dois tipos (kind): "student" (aluno↔1 ou aluno↔N personas) ou "persona_exchange" (duas personas conversam entre si sobre um "foco"; o aluno observa). Cada interação tem um objetivo.
  - objetivos válidos (objective_type): ${objList}.
  - papéis válidos por participante numa interação "student" (role): ${roleList}.

COMO RESPONDER (SEMPRE só JSON, neste formato):
{
  "reply": "resposta conversacional ao professor, em português, curta e prática. Explique o que você propôs e por quê. Se faltar informação, pergunte.",
  "scenario_patch": { "name": "...", "description": "..." } | null,   // ajuste do nome/explicação geral; null se não mudar
  "new_personas": [
    { "name": "...", "role": "...", "tone": "...", "description": "...", "objectives": ["..."], "concerns": ["..."], "knowledge_scope": ["..."] }
  ],
  "new_interactions": [
    { "title": "...", "kind": "student | persona_exchange", "objective_type": "<um dos válidos>", "instruction": "instrução ao aluno (em student)", "focus": "foco (só em persona_exchange)",
      "participants": [ { "persona_name": "<nome de uma persona NOVA acima OU já existente no cenário>", "role": "<um dos papéis válidos; ignorado em persona_exchange>" } ] }
  ]
}

REGRAS:
- Proponha incrementos coerentes com o que o professor pediu. Não invente um cenário inteiro se ele só pediu uma persona.
- Em "participants", refira personas por NOME (a interface resolve o id). persona_exchange precisa de exatamente 2 personas.
- Liste em new_personas só personas que ainda não existem no cenário (o estado atual vem no input). Para reusar uma persona existente, referencie pelo nome em participants sem recriá-la.
- Use objetivos e papéis APENAS da lista válida.
- Seja conciso. Não despeje listas enormes; proponha o essencial e ofereça refinar.`;
    }

    /**
     * @param {object} p
     * @param {object} p.scenario   estado atual { name, description, personas:[{name,role}], interactions:[{title,kind,objective_type}] }
     * @param {Array}  p.templates  biblioteca de templates disponível [{name, role}]
     * @param {Array}  p.history    turnos anteriores [{role:'user'|'assistant', content}]
     * @param {string} p.message    mensagem do professor
     * @param {object|null} p.meterCtx
     */
    async chat({ scenario = {}, templates = [], history = [], message, meterCtx = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const state = {
            name: scenario.name || "(sem nome)",
            description: scenario.description || "(sem explicação)",
            personas: (scenario.personas || []).map(p => ({ name: p.name, role: p.role })),
            interactions: (scenario.interactions || []).map(it => ({ title: it.title, kind: it.kind, objective_type: it.objective_type })),
        };
        const histBlock = (history || []).slice(-8).map(h => `${h.role === "assistant" ? "ASSISTENTE" : "PROFESSOR"}: ${h.content}`).join("\n") || "(início da conversa)";
        const userContent = `**ESTADO ATUAL DO CENÁRIO EM EDIÇÃO**
${JSON.stringify(state, null, 2)}

**TEMPLATES DISPONÍVEIS NA BIBLIOTECA** (pode sugerir reusar)
${(templates || []).map(t => `- ${t.name} (${t.role})`).join("\n") || "(nenhum)"}

**HISTÓRICO DA CONVERSA**
${histBlock}

**MENSAGEM DO PROFESSOR**
${message}

Responda SOMENTE com o JSON do formato especificado.`;

        log.prompt("AGENT:ScenarioAssistant", `system+user (${systemPrompt.length + userContent.length} chars)`);
        const response = await log.span("AGENT:ScenarioAssistant", "responses.create", () =>
            meteredResponses({ ...meterCtx, agentLabel: "AGENT:ScenarioAssistant", model: this.model }, () =>
                this.client.responses.create({ model: this.model, instructions: systemPrompt, input: [{ role: "user", content: userContent }], truncation: "auto" })));
        const parsed = extractJsonObject(response.output_text || "");
        if (!parsed || typeof parsed.reply !== "string") {
            return { reply: "Desculpe, não consegui formular uma proposta agora. Pode reformular?", scenario_patch: null, new_personas: [], new_interactions: [] };
        }
        // Saneamento leve: enums válidos; persona_exchange com exatamente 2.
        const newInteractions = (Array.isArray(parsed.new_interactions) ? parsed.new_interactions : []).filter(it => it && it.title && INTERACTION_KINDS.includes(it.kind) && OBJECTIVE_TYPES.includes(it.objective_type)).map(it => ({
            title: String(it.title), kind: it.kind, objective_type: it.objective_type,
            instruction: typeof it.instruction === "string" ? it.instruction : "",
            focus: it.kind === "persona_exchange" && typeof it.focus === "string" ? it.focus : "",
            participants: (Array.isArray(it.participants) ? it.participants : []).filter(p => p && p.persona_name).map(p => ({ persona_name: String(p.persona_name), role: PARTICIPANT_ROLES.includes(p.role) ? p.role : "questionamento" })),
        }));
        log.info("AGENT:ScenarioAssistant", `reply=${log.preview(parsed.reply, 80)} personas=${(parsed.new_personas || []).length} interactions=${newInteractions.length}`);
        return {
            reply: parsed.reply,
            scenario_patch: parsed.scenario_patch && typeof parsed.scenario_patch === "object" ? parsed.scenario_patch : null,
            new_personas: Array.isArray(parsed.new_personas) ? parsed.new_personas.filter(p => p && p.name && p.role) : [],
            new_interactions: newInteractions,
        };
    }
}

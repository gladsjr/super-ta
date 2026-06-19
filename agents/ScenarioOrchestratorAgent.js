import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble, EXTEMPORANEOUS_ANSWER_PRINCIPLE } from "../lib/agentPreamble.js";
import { renderInteractionBriefing } from "../lib/scenarios/agenda.js";
import {
    SCENARIO_TURN_SCHEMA_DESCRIPTION, PERSONA_EXCHANGE_SCHEMA_DESCRIPTION,
    validateScenarioTurn, validatePersonaExchange, extractJsonObject,
} from "../lib/scenarios/scenarioActionSchema.js";

// Normaliza o speaker devolvido pelo LLM: aceita id; remapeia nome→id; cai num
// participante razoável se vier vazio/desconhecido (o modelo às vezes devolve o
// NOME em vez do id, ou omite). Garante um id válido para o engine não quebrar.
export function resolveSpeaker(raw, allowedIds, personasById, interaction) {
    if (allowedIds.includes(raw)) return raw;
    const n = String(raw || "").trim().toLowerCase();
    if (n) {
        for (const id of allowedIds) {
            const nm = (personasById[id]?.name || "").toLowerCase();
            if (nm && (nm === n || n.includes(nm) || nm.includes(n))) return id;
        }
    }
    const opener = interaction?.opener_persona_id;
    return allowedIds.includes(opener) ? opener : allowedIds[0];
}

/**
 * ScenarioOrchestratorAgent — orquestrador do sistema MULTIAGENTE.
 *
 * Generaliza o SuperOrchestratorAgent (que conduz UMA persona numa entrevista)
 * para o contexto do cenário: várias personas participam de cada interação, em
 * sequência ordenada. Uma chamada de raciocínio por turno decide QUAL persona
 * fala e O QUE ela diz (turno "student"), ou gera a troca entre duas personas
 * (persona↔persona). A navegação ENTRE interações é do código (liveEngine), não
 * deste agente; os guardrails (falante válido, teto de turnos, bloqueio de
 * advance precoce) também ficam no código.
 *
 * Audience: student_via_interviewer_voice — action.message / lines[].message vão
 * à outra ponta na voz da persona, sem edição.
 */
export class ScenarioOrchestratorAgent {
    static TYPE = "scenario_orchestrator";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ScenarioOrchestratorAgent");
        this.client = openaiClient;
        this.model = model;

        this.turnSystemBody = `Sua função: conduzir UM TURNO de uma INTERAÇÃO de role-play multiagente. A cena é definida no BRIEFING DA INTERAÇÃO (no user prompt): o cenário geral, o objetivo desta etapa, a instrução, as PERSONAS participantes (cada uma com sua agenda) e a memória do que já aconteceu. Você decide QUAL persona responde agora e O QUE ela diz — e devolve um JSON no schema abaixo. O código traduz seu output em comportamento real.

VOCÊ ENCARNA A PERSONA QUE ESCOLHER em speaker_persona_id. A fala em action.message sai na voz dessa persona, sem edição — vocabulário, postura e registro são os dela (definidos na agenda). Dentro da cena não há "aluno" nem "avaliação": há personas conduzindo a situação com quem está do outro lado.

ESCOLHA DE QUEM FALA (speaker_persona_id):
- DEVE ser uma das personas participantes listadas no briefing.
- Com uma única persona, é sempre ela.
- Com várias, faça a conversa parecer real: quem "conduz a entrevista" tende a abrir e reconduzir; quem "questiona" entra para pressionar pontos da sua preocupação; quem "participa da discussão" complementa. Não deixe uma só persona monopolizar sem motivo — alterne conforme o que a última fala da outra ponta puxa, e conforme os objetivos/preocupações de cada uma. Uma persona por turno.

QUANDO USAR CADA action.kind:
- "speak": a persona escolhida reage à última fala da outra ponta e/ou avança a agenda dela (pergunta, sondagem, provocação no registro da persona). action.message OBRIGATÓRIA.
- "advance": o OBJETIVO desta interação já foi suficientemente coberto — sinalize para passar à próxima etapa do cenário. message pode ser uma fala curta de transição ("acho que por aqui já entendi o suficiente") ou vazia.
- "finalize": a outra ponta sinalizou que quer encerrar / desengajou. message curto de fechamento, em personagem.

RITMO E ENCERRAMENTO (importante — o objetivo é uma etapa que FECHA bem, não que se arrasta):
- NÃO esgote o assunto. Quando os pontos centrais do objetivo desta etapa já foram tocados — tipicamente após 2 a 4 trocas — PREFIRA "advance" com uma fala CURTA de fechamento em action.message (ex.: "ok, por aqui já tenho o que precisava, vamos seguir"), em vez de abrir mais uma pergunta nova.
- NÃO encerre no meio de uma pergunta sua: se no ÚLTIMO turno VOCÊ fez uma pergunta e a outra ponta ainda não respondeu, NÃO use advance — dê a ela a chance de responder primeiro.
- Em etapas de objetivo "feedback" ou "apresentação", o fechamento costuma vir mais cedo; em "negociação"/"avaliação"/"discussão" você pode pressionar um pouco mais, mas ainda assim FECHE com uma fala de transição em vez de cortar seco.

${EXTEMPORANEOUS_ANSWER_PRINCIPLE}

REGRAS:
- NÃO invente fatos que a persona não teria como saber. Se a outra ponta perguntar algo fora do alcance da persona/cenário, desconverse no registro da persona e reconduza ao foco — não fabrique dados.
- A pressão é sobre o conteúdo, no registro da persona; nunca sobre a pessoa.
- rationale é OBRIGATÓRIO (auditoria do professor, 1–3 frases): justifique quem falou e por quê.

SCHEMA DE SAÍDA (RETORNAR APENAS JSON):
${SCENARIO_TURN_SCHEMA_DESCRIPTION}`;

        this.exchangeSystemBody = `Sua função: gerar uma TROCA CURTA entre DUAS personas que conversam ENTRE SI (a outra ponta apenas observa). A cena está no BRIEFING DA INTERAÇÃO (no user prompt): o cenário, o FOCO do que as duas discutem, as duas personas (com suas agendas) e a memória do que já aconteceu — incluindo o que a outra ponta apresentou antes.

Produza de 2 a 4 falas, alternando entre as duas personas, cada uma encarnando a sua agenda (papel, tom, preocupações, critérios). A troca deve girar em torno do FOCO e referenciar o que ouviram da outra ponta nas interações anteriores (use a memória do cenário). Soa como duas pessoas deliberando — concordâncias parciais, divergências, ressalvas — não como um resumo neutro.

REGRAS:
- Cada line.speaker_persona_id DEVE ser uma das duas personas participantes.
- Não inclua fala da outra ponta — ela só observa.
- Não invente fatos fora do alcance das personas/cenário.
- rationale OBRIGATÓRIO (auditoria, 1–2 frases).

SCHEMA DE SAÍDA (RETORNAR APENAS JSON):
${PERSONA_EXCHANGE_SCHEMA_DESCRIPTION}`;
    }

    // ---- chamada base (blocking; sem streaming — o harness de teste é texto) ----
    async _call(systemPrompt, userContent, { meterCtx, vectorStoreId, label }) {
        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{ role: "user", content: userContent }],
            truncation: "auto",
        };
        if (vectorStoreId) payload.tools = [{ type: "file_search", vector_store_ids: [vectorStoreId] }];
        log.prompt(label, `system+user (${systemPrompt.length + userContent.length} chars)`);
        const MAX = 2;
        let text, apiErr = null;
        for (let attempt = 1; attempt <= MAX; attempt++) {
            try {
                const response = await log.span(label, `responses.create${attempt > 1 ? ` retry#${attempt}` : ""}`, () =>
                    meteredResponses({ ...meterCtx, agentLabel: label, model: this.model }, () => this.client.responses.create(payload)));
                text = response.output_text || "";
                apiErr = null;
                break;
            } catch (err) {
                apiErr = err;
                log.error(label, `chamada falhou (${attempt}/${MAX}): ${err.message}`);
                if (attempt >= MAX) break;
                await new Promise(r => setTimeout(r, 600 * attempt));
            }
        }
        if (apiErr) throw apiErr;
        return text;
    }

    /**
     * Um turno de interação "student": escolhe a persona que fala e a fala dela.
     * @returns {{speaker_persona_id, action:{kind,message}, rationale, memory}}
     */
    async studentTurn({
        scenario, interaction, personasById, position, total, runMemory,
        interactionTranscript = [], memory = null, studentMessage,
        isOpening = false, vectorStoreId = null, interactionMode = "text",
        studentName = null, studentGenderHint = null, meterCtx = null,
    }) {
        const allowedIds = (interaction.participants || []).map(p => p.persona_id);
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode, studentName, studentGenderHint })}

${this.turnSystemBody}`;
        const briefing = renderInteractionBriefing({ scenario, interaction, personasById, position, total, runMemory });
        const historyBlock = isOpening
            ? "(ABERTURA — a outra ponta ainda não falou. A persona que abre (opener) deve se apresentar brevemente e dar início conforme a instrução desta etapa.)"
            : (interactionTranscript.length
                ? interactionTranscript.map(e => `${e.kind === "student" ? "OUTRA PONTA" : (e.name || "persona")}: ${e.text}`).join("\n")
                : "(sem falas ainda nesta interação)");
        const openerHint = isOpening && interaction.opener_persona_id
            ? `\nPersona que abre (use como speaker_persona_id): ${interaction.opener_persona_id}`
            : "";
        const memoryBlock = memory ? JSON.stringify(memory, null, 2) : "(vazio — primeiro turno desta interação)";
        const userContent = `${briefing}

**HISTÓRICO DESTA INTERAÇÃO (em ordem)**
${historyBlock}${openerHint}

**SEU ESTADO INTERNO (memory do turno anterior)**
${memoryBlock}

**FALA RECÉM-RECEBIDA DA OUTRA PONTA**
"""
${isOpening ? "(ainda não há fala — esta é a abertura)" : (studentMessage || "")}
"""

IDS VÁLIDOS para speaker_persona_id (use o ID exatamente, NÃO o nome): ${allowedIds.join(", ")}
Escolha quem fala e a próxima ação. Retorne SOMENTE o JSON do schema.`;

        // Retry (2x) em no-JSON / schema-inválido: o gpt-5.5 às vezes devolve
        // prosa ou um shape levemente fora. Custa só quando falha (raro).
        let parsed = null, lastErr = "";
        for (let attempt = 1; attempt <= 2; attempt++) {
            const text = await this._call(systemPrompt, userContent, { meterCtx, vectorStoreId, label: "AGENT:ScenarioOrchestrator" });
            const p = extractJsonObject(text);
            if (!p) { lastErr = "no JSON in response"; continue; }
            p.speaker_persona_id = resolveSpeaker(p.speaker_persona_id, allowedIds, personasById, interaction);
            const v = validateScenarioTurn(p, allowedIds);
            if (!v.valid) { lastErr = `schema invalid (${v.errors.join("; ")})`; continue; }
            parsed = p; break;
        }
        if (!parsed) throw new Error(`ScenarioOrchestratorAgent.studentTurn: ${lastErr}`);
        log.info("AGENT:ScenarioOrchestrator", `kind=${parsed.action.kind} speaker=${parsed.speaker_persona_id} msg=${log.preview(parsed.action.message, 80)}`);
        return parsed;
    }

    /**
     * Troca persona↔persona: 2–4 falas entre as duas personas sobre o foco.
     * @returns {{lines:Array<{speaker_persona_id,message}>, rationale}}
     */
    async personaExchange({
        scenario, interaction, personasById, position, total, runMemory,
        interactionMode = "text", meterCtx = null,
    }) {
        const allowedIds = (interaction.participants || []).map(p => p.persona_id);
        const systemPrompt = `${renderAgentPreamble({ audience: "student_via_interviewer_voice", interactionMode })}

${this.exchangeSystemBody}`;
        const briefing = renderInteractionBriefing({ scenario, interaction, personasById, position, total, runMemory });
        const userContent = `${briefing}

IDS VÁLIDOS para speaker_persona_id (use o ID exatamente, NÃO o nome): ${allowedIds.join(", ")}
Gere a troca entre as duas personas sobre o foco. Retorne SOMENTE o JSON do schema.`;
        let parsed = null, lastErr = "";
        for (let attempt = 1; attempt <= 2; attempt++) {
            const text = await this._call(systemPrompt, userContent, { meterCtx, vectorStoreId: null, label: "AGENT:ScenarioOrchestrator:exchange" });
            const p = extractJsonObject(text);
            if (!p) { lastErr = "no JSON in response"; continue; }
            if (Array.isArray(p.lines)) p.lines.forEach((l, i) => { if (l) l.speaker_persona_id = resolveSpeaker(l.speaker_persona_id, allowedIds, personasById, interaction) || allowedIds[i % allowedIds.length]; });
            const v = validatePersonaExchange(p, allowedIds);
            if (!v.valid) { lastErr = `schema invalid (${v.errors.join("; ")})`; continue; }
            parsed = p; break;
        }
        if (!parsed) throw new Error(`ScenarioOrchestratorAgent.personaExchange: ${lastErr}`);
        log.info("AGENT:ScenarioOrchestrator", `exchange lines=${parsed.lines.length}`);
        return parsed;
    }

    /** Abertura de uma interação "student": delega para studentTurn com isOpening. */
    async interactionOpener(args) {
        return this.studentTurn({ ...args, isOpening: true });
    }
}

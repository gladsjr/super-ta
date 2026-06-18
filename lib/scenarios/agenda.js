// Renderização de contexto para o orquestrador multiagente.
//
// Espelha o mecanismo de lib/interviewerAgenda.js (template explicado em prosa
// + substituição), mas para o modelo do CENÁRIO: uma PERSONA do cenário e o
// BRIEFING de uma INTERAÇÃO (objetivo, instrução, foco, posição na sequência,
// participantes e memória de run). Honra o CLAUDE.md: a definição estruturada
// nunca vai crua ao LLM — sempre via template que explica cada campo.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applySubs } from "../interviewerAgenda.js";
import { objectiveLabel, ROLE_LABEL } from "./mockEngine.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(LIB_DIR, "..", "..", "config");
const PERSONA_TEMPLATE_PATH = path.join(CONFIG_DIR, "scenario_persona_template.txt");
const INTERACTION_TEMPLATE_PATH = path.join(CONFIG_DIR, "scenario_interaction_template.txt");

const _cache = {};
function loadTemplate(p) {
    if (_cache[p] == null) _cache[p] = fs.readFileSync(p, "utf8");
    return _cache[p];
}

const str = v => (v == null ? "" : String(v));
// Lista como bullets indentados; "(não informado)" quando vazia, para o LLM
// não tratar ausência como lista de um item vazio.
function listBlock(value, indent = 4) {
    const pad = " ".repeat(indent);
    const list = Array.isArray(value) ? value.filter(x => x != null && String(x).trim()) : (value ? [value] : []);
    if (!list.length) return `${pad}(não informado)`;
    return list.map(x => `${pad}- ${String(x).trim()}`).join("\n");
}

// Renderiza o bloco de agenda de UMA persona do cenário.
export function renderPersonaAgenda(persona) {
    const p = persona || {};
    const k = p.knowledge || {};
    const subs = {
        name: str(p.name),
        role: str(p.role),
        description: str(p.description),
        authority: str(p.authority),
        tone: str(p.tone),
        objectives_block: listBlock(p.objectives),
        concerns_block: listBlock(p.concerns),
        decision_criteria_block: listBlock(p.decision_criteria),
        constraints_block: listBlock(p.constraints),
        information_needs_block: listBlock(p.information_needs),
        evaluation_mode_block: listBlock(p.evaluation_mode),
        knowledge_scope_block: listBlock(k.scope),
        knowledge_assets_block: listBlock((k.assets || []).map(a => (a && a.label) ? `${a.label}${a.type ? ` (${a.type})` : ""}` : null)),
        knowledge_level: str(k.level),
    };
    return applySubs(loadTemplate(PERSONA_TEMPLATE_PATH), subs);
}

// Briefing completo de uma interação: cenário geral + esta etapa + participantes
// (com a agenda de cada persona) + memória de run.
export function renderInteractionBriefing({ scenario, interaction, personasById, position, total, runMemory }) {
    const it = interaction || {};
    const isExchange = it.kind === "persona_exchange";
    const participants = (it.participants || []).map(part => ({
        persona: personasById[part.persona_id] || null,
        role: part.role,
    })).filter(x => x.persona);

    const participantsBlock = participants.map(({ persona, role }) => {
        const roleLine = isExchange
            ? `(persona em conversa com a outra persona)`
            : `papel nesta interação: ${ROLE_LABEL[role] || role}`;
        return `### ${persona.name}  ·  id: \`${persona.id}\`  ·  ${roleLine}\n${renderPersonaAgenda(persona)}`;
    }).join("\n\n");

    const subs = {
        scenario_name: str(scenario?.name),
        scenario_description: str(scenario?.description) || "(sem descrição geral)",
        position: String(position ?? 1),
        total: String(total ?? 1),
        interaction_title: str(it.title),
        objective_label: objectiveLabel(it.objective_type),
        instruction: str(it.instruction) || "(sem instrução específica)",
        focus_line: isExchange && it.focus ? `Foco da conversa entre as personas: ${str(it.focus)}` : "",
        participants_block: participantsBlock || "(nenhuma persona)",
        run_memory: str(runMemory) || "(primeira interação — sem histórico anterior)",
    };
    return applySubs(loadTemplate(INTERACTION_TEMPLATE_PATH), subs);
}

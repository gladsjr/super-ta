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
import { ROLE_LABEL } from "./mockEngine.js";
import { formDynamics, normalizeForm } from "./interactionForms.js";

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
export function renderPersonaAgenda(persona, { includeEvaluation = true } = {}) {
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
        constraints_block: listBlock(p.constraints),
        information_needs_block: listBlock(p.information_needs),
        // decision_criteria e evaluation_mode são material de AVALIAÇÃO (rubrica), não
        // roteiro de fala: decision_criteria não vai mais à persona viva (evita que ela
        // "recite a rubrica"); evaluation_mode só entra quando ela ARGUI, não quando é fonte.
        evaluation_section: includeEvaluation
            ? `- Modo de avaliação:\n${listBlock(p.evaluation_mode)}\n  Como a persona testa/pressiona: pede exemplos, cobra justificativas, explora inconsistências, tensiona premissas.`
            : `- Postura nesta etapa: você é FONTE — o aluno conduz. Responda e revele o que sabe conforme ele perguntar; NÃO cobre nem teste o aluno, e não faça "as perguntas da avaliação". Deixe que ele estruture a análise.`,
        knowledge_scope_block: listBlock(k.scope),
        knowledge_assets_block: listBlock((k.assets || []).map(a => (a && a.label) ? `${a.label}${a.type ? ` (${a.type})` : ""}` : null)),
        knowledge_level: str(k.level),
    };
    return applySubs(loadTemplate(PERSONA_TEMPLATE_PATH), subs);
}

// Briefing completo de uma interação: cenário geral + esta etapa + participantes
// (com a agenda de cada persona) + memória de run.
export function renderInteractionBriefing({ scenario, interaction, personasById, position, total, runMemory, enunciadoAvailable = false, studentWorkAvailable = false, artifactAvailable = false }) {
    const it = interaction || {};
    const isExchange = it.kind === "persona_exchange";
    // CAMADA: a dinâmica vem da FORMA (ou do form_prompt, na forma custom / como nuance).
    const form = normalizeForm(it);
    const fp = str(it.form_prompt);
    const dynamics_block = form === "custom"
        ? (fp || "(dinâmica personalizada não informada — conduza pela cena e pela agenda da persona)")
        : (formDynamics(form) + (fp ? `\n\nNuance do professor: ${fp}` : ""));
    // MATERIAIS: o que está consultável via file_search NESTA etapa.
    const mats = [];
    if (enunciadoAvailable) mats.push("- O ENUNCIADO/CASO do cenário está disponível para consulta (file_search).");
    if (studentWorkAvailable) mats.push("- O TRABALHO DO ALUNO desta etapa está disponível para consulta (file_search) — use-o conforme a DINÂMICA acima.");
    if (artifactAvailable) mats.push("- O MATERIAL desta etapa (documento que o ALUNO TAMBÉM LEU) está disponível para consulta (file_search) — é conhecimento COMPARTILHADO entre vocês: cite e discuta seu conteúdo abertamente, na sua voz, sem tratá-lo como segredo nem como 'arquivo/documento'.");
    const materials_block = mats.length ? mats.join("\n") : "(nenhum material anexado nesta etapa — conduza pela cena e pela agenda da persona)";
    const participants = (it.participants || []).map(part => ({
        persona: personasById[part.persona_id] || null,
        role: part.role,
    })).filter(x => x.persona);

    // Informação PRIVADA por persona (detida pela persona, desconhecida do aluno;
    // revelada só nesta etapa, se perguntada/conduzida). Mapeia persona_id → textos.
    const privateByPersona = {};
    for (const pi of (it.private_info || [])) {
        const hasArtifact = !!(pi.artifact && pi.artifact.vector_store_id);
        for (const pid of (pi.persona_ids || [])) (privateByPersona[pid] = privateByPersona[pid] || []).push({ text: str(pi.text), hasArtifact });
    }
    const participantsBlock = participants.map(({ persona, role }) => {
        const roleLine = isExchange
            ? `(persona em conversa com a outra persona)`
            : `papel nesta interação: ${ROLE_LABEL[role] || role}`;
        const priv = (privateByPersona[persona.id] || []).filter(x => x.text || x.hasArtifact);
        const privBlock = priv.length
            ? `\nINFORMAÇÃO QUE SÓ VOCÊ TEM NESTA ETAPA (a outra ponta NÃO sabe disto). REVELE apenas se ela perguntar ou conduzir a conversa até aqui — não entregue de graça, não despeje tudo de uma vez; vá soltando conforme a conversa pedir:\n${priv.map(x => {
                const out = [];
                if (x.text) out.push(`- ${x.text.trim()}`);
                if (x.hasArtifact) out.push(`- (há um MATERIAL PRIVADO seu, consultável via file_search, com mais detalhes desta informação — incorpore o conteúdo e revele aos poucos, conforme a conversa pedir, na SUA voz, sem citar "documento"/"arquivo")`);
                return out.join("\n");
              }).filter(Boolean).join("\n")}`
            : "";
        return `### ${persona.name}  ·  id: \`${persona.id}\`  ·  ${roleLine}\n${renderPersonaAgenda(persona, { includeEvaluation: !isExchange && role !== "fonte" })}${privBlock}`;
    }).join("\n\n");

    // Exemplos de falas das personas nesta etapa (inspiração; antigo "perguntas de exemplo").
    const examples = (it.example_questions || []).map(x => str(x).trim()).filter(Boolean);
    const examples_block = examples.length
        ? `\n**EXEMPLOS DE FALAS DAS PERSONAS** (inspiração de tom/abordagem para esta etapa — adapte ao contexto, não recite literalmente)\n${examples.map(x => `- ${x}`).join("\n")}\n`
        : "";

    // REGRAS DO CENÁRIO (globais): fora de escopo + premissas. Só entram se preenchidas.
    const oos = str(scenario?.out_of_scope).trim();
    const prem = str(scenario?.premissas).trim();
    const ruleParts = [];
    if (oos) ruleParts.push(`FORA DO ESCOPO — NUNCA aborde estes tópicos por iniciativa própria. Se a outra ponta insistir num deles, responda de forma EVASIVA / redirecione ao foco da etapa, SEM declarar que "está fora do escopo"; e, nesse caso, preencha action.hint (ver schema) para avisar o aluno, em meta, que o tópico está fora do escopo:\n${oos}`);
    if (prem) ruleParts.push(`PREMISSAS — pressupostos que TODOS (você e a outra ponta) já conhecem e tomam como dados. Só as mencione se for perguntado OU se a fala/trabalho da outra ponta CONTRARIAR uma premissa — aí questione:\n${prem}`);
    const rules_block = ruleParts.length
        ? `\n**REGRAS DO CENÁRIO** (valem em TODAS as etapas)\n${ruleParts.join("\n\n")}\n`
        : "";

    // TEMPO da etapa (minutos). Só entra quando o professor definiu um limite.
    const tl = (typeof it.time_limit_min === "number" && it.time_limit_min > 0) ? Math.round(it.time_limit_min) : null;
    const time_block = tl
        ? `\n**TEMPO DESTA ETAPA**: você tem cerca de ${tl} minuto(s) para esta interação. Na sua 1ª fala, mencione esse tempo de forma natural, na sua voz. Conduza no ritmo: quando o tempo for ficando curto, encaminhe o fechamento; ao ser avisado de que falta pouco, aceite mais UMA resposta e despeça-se (finalize).\n`
        : "";

    const subs = {
        scenario_name: str(scenario?.name),
        scenario_description: str(scenario?.description) || "(sem descrição geral)",
        rules_block,
        position: String(position ?? 1),
        total: String(total ?? 1),
        interaction_title: str(it.title),
        instruction: str(it.instruction) || "(sem instrução específica)",
        focus_line: isExchange && it.focus ? `Foco da conversa entre as personas: ${str(it.focus)}` : "",
        time_block,
        dynamics_block,
        materials_block,
        examples_block,
        participants_block: participantsBlock || "(nenhuma persona)",
        run_memory: str(runMemory) || "(primeira interação — sem histórico anterior)",
    };
    return applySubs(loadTemplate(INTERACTION_TEMPLATE_PATH), subs);
}

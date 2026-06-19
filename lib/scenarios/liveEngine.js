// Motor de orquestração MULTIAGENTE — versão REAL (chama o LLM).
//
// Contraparte do mockEngine: mesma INTERFACE e mesmo FORMATO de saída (entradas
// kind scenario/interaction/persona/aside/student), para a UI/runner renderizar
// igual. A diferença é que as falas vêm do ScenarioOrchestratorAgent em vez de
// templates roteirizados.
//
// O agente é INJETADO (1º parâmetro) — assim os testes da Fase 0 passam um stub
// e exercitam os guardrails sem gastar token. Os guardrails (falante válido,
// teto de turnos por interação) e a memória de run vivem AQUI, no código, não
// no LLM. A navegação entre interações continua nas rotas/harness.

import { entry, interactionHeader, scenarioFrame, objectiveLabel, ROLE_LABEL } from "./mockEngine.js";

export { scenarioFrame }; // reexport: idêntico ao mock (sem LLM)

// Teto duro de turnos do aluno por interação — guardrail de custo/loop.
export const MAX_STUDENT_TURNS_PER_INTERACTION = 8;

const trunc = (s, n = 220) => { const t = String(s || "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

// Segmenta o transcript por cabeçalho de interação. segments[i] = entradas da
// interação i (sem o cabeçalho). A frame do cenário (antes do 1º cabeçalho) fica
// fora dos segmentos.
function splitByInteraction(transcript) {
    const segs = []; let cur = null;
    for (const e of transcript || []) {
        if (e.kind === "interaction") { cur = []; segs.push(cur); }
        else if (cur) cur.push(e);
    }
    return segs;
}

// Conta turnos do aluno na interação corrente (após o último cabeçalho).
export function studentTurnsInCurrent(transcript) {
    let n = 0;
    for (let i = (transcript || []).length - 1; i >= 0; i--) {
        if (transcript[i].kind === "interaction") break;
        if (transcript[i].kind === "student") n++;
    }
    return n;
}

// Memória de run DETERMINÍSTICA: resume as interações anteriores a partir do
// transcript (sem LLM). É o que permite a uma interação referenciar o que houve
// antes (ex.: a banca deliberar sobre o que ouviu). Upgrade futuro: resumo por
// LLM se a Fase 1 mostrar que o determinístico é fraco.
export function buildRunMemory(scenario, transcript, uptoIdx) {
    const segs = splitByInteraction(transcript);
    const lines = [];
    for (let i = 0; i < uptoIdx; i++) {
        const it = (scenario.interactions || [])[i]; if (!it) continue;
        const seg = segs[i] || [];
        const studentTexts = seg.filter(e => e.kind === "student").map(e => `"${trunc(e.text)}"`);
        const asides = seg.filter(e => e.kind === "aside").map(e => `${e.name}: ${trunc(e.text, 140)}`);
        const parts = [];
        if (studentTexts.length) parts.push(`a outra ponta disse: ${studentTexts.join("; ")}`);
        if (asides.length) parts.push(`as personas trocaram: ${asides.join(" / ")}`);
        lines.push(`- "${it.title}" (${objectiveLabel(it.objective_type)}): ${parts.join(". ") || "sem falas registradas"}`);
    }
    return lines.join("\n");
}

const otherParticipantId = (interaction, id) =>
    (interaction.participants || []).map(p => p.persona_id).find(pid => pid !== id) || null;
const roleOf = (interaction, id) => (interaction.participants || []).find(p => p.persona_id === id)?.role;

// Início de uma interação (real). Cabeçalho determinístico + abertura via LLM.
export async function interactionStartLive(agent, { scenario, interaction, personasById, idx, total, runMemory = "", meterCtx = null, interactionMode = "text" }) {
    const header = interactionHeader(interaction, personasById, idx, total);
    const position = idx + 1;

    if (interaction.kind === "persona_exchange") {
        const ex = await agent.personaExchange({ scenario, interaction, personasById, position, total, runMemory, interactionMode, meterCtx });
        const ids = (interaction.participants || []).map(p => p.persona_id);
        const asides = (ex.lines || []).map(l => {
            const sp = personasById[l.speaker_persona_id] || personasById[ids[0]];
            return entry(sp, "aside", l.message, { to: otherParticipantId(interaction, sp?.id) });
        });
        return [header, ...asides];
    }

    const op = await agent.interactionOpener({ scenario, interaction, personasById, position, total, runMemory, interactionMode, meterCtx });
    // Guardrail: falante válido — cai no opener_persona_id, depois no 1º participante.
    const speaker = personasById[op.speaker_persona_id]
        || personasById[interaction.opener_persona_id]
        || personasById[(interaction.participants || [])[0]?.persona_id];
    return [header, entry(speaker, "persona", op.action.message, { role: roleOf(interaction, speaker?.id) })];
}

// Resposta das personas a uma fala do aluno (real). Só interações "student".
// O chamador já empurrou a fala do aluno no transcript (igual ao mock).
// Retorna { entries, action, memory } — o chamador decide avançar conforme action.kind.
export async function respondLive(agent, { scenario, interaction, personasById, idx, total, transcript, memory = null, meterCtx = null, interactionMode = "text", studentName = null, studentGenderHint = null, vectorStoreId = null, onFirstDelta = null, onMessageReady = null }) {
    if (interaction.kind !== "student") return { entries: [], action: { kind: "advance" }, memory };

    // Guardrail: teto de turnos da interação → força avanço.
    if (studentTurnsInCurrent(transcript) >= MAX_STUDENT_TURNS_PER_INTERACTION) {
        return { entries: [], action: { kind: "advance", message: "" }, memory, capped: true };
    }

    const seg = splitByInteraction(transcript).pop() || [];
    const lastStudentIdx = [...seg].map(e => e.kind).lastIndexOf("student");
    const studentMessage = lastStudentIdx >= 0 ? seg[lastStudentIdx].text : "";
    const interactionTranscript = lastStudentIdx >= 0 ? seg.slice(0, lastStudentIdx) : seg;
    const runMemory = buildRunMemory(scenario, transcript, idx);

    const out = await agent.studentTurn({
        scenario, interaction, personasById, position: idx + 1, total, runMemory,
        interactionTranscript, memory, studentMessage,
        vectorStoreId, interactionMode, studentName, studentGenderHint, meterCtx,
        onFirstDelta, onMessageReady,
    });

    // Guardrail: falante válido (defensivo — o schema já valida).
    const speaker = personasById[out.speaker_persona_id] || personasById[(interaction.participants || [])[0]?.persona_id];
    const kind = out.action?.kind || "speak";
    const entries = [];
    if (kind === "speak" || out.action?.message) {
        entries.push(entry(speaker, "persona", out.action.message, { role: roleOf(interaction, speaker?.id) }));
    }
    return { entries, action: out.action, memory: out.memory ?? memory };
}

export { ROLE_LABEL };

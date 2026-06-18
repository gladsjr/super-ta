// API do sistema de CENÁRIOS MULTIAGENTE (fase mock).
//
// Duas superfícies de definição (personas e cenários) + execução mock. NÃO usa
// LLM nem Postgres (store em JSON). Sem auth nesta fase — é um protótipo para
// validar o desenho; antes de produção, gatear atrás do login do professor
// (requireAdmin) e migrar o store para o banco.

import express from "express";
import * as store from "../lib/scenarios/store.js";
import {
    openingTurns, respond, OBJECTIVE_TYPES, PARTICIPANT_ROLES, INTERACTION_MODES, objectiveLabel, ROLE_LABEL,
} from "../lib/scenarios/mockEngine.js";

const router = express.Router();
const json = express.json({ limit: "256kb" });

const bad = (res, msg) => res.status(400).json({ error: msg });

// ---- Meta (enums para a UI) ----
router.get("/scenarios/api/meta", (_req, res) => {
    res.json({
        objective_types: OBJECTIVE_TYPES.map(v => ({ value: v, label: objectiveLabel(v) })),
        participant_roles: PARTICIPANT_ROLES.map(v => ({ value: v, label: ROLE_LABEL[v] || v })),
        interaction_modes: INTERACTION_MODES.map(v => ({ value: v, label: v === "sincrono" ? "Síncrono (ao vivo)" : "Assíncrono (responde quando puder)" })),
    });
});

// ---- Personas ----
function validatePersona(b) {
    if (!b || typeof b !== "object") return "persona inválida";
    if (typeof b.name !== "string" || !b.name.trim()) return "nome da persona é obrigatório";
    if (typeof b.role !== "string" || !b.role.trim()) return "papel da persona é obrigatório";
    return null;
}
function cleanPersona(b) {
    const arr = (x) => Array.isArray(x) ? x.map(s => String(s).trim()).filter(Boolean) : [];
    return {
        ...(b.id ? { id: b.id } : {}),
        name: b.name.trim(),
        icon: typeof b.icon === "string" && b.icon.trim() ? b.icon.trim() : "🧑",
        role: b.role.trim(),
        tone: typeof b.tone === "string" ? b.tone.trim() : "",
        objectives: arr(b.objectives),
        concerns: arr(b.concerns),
        knowledge: typeof b.knowledge === "string" ? b.knowledge.trim() : "",
    };
}

router.get("/scenarios/api/personas", async (_req, res) => {
    res.json({ personas: await store.listPersonas() });
});
router.post("/scenarios/api/personas", json, async (req, res) => {
    const err = validatePersona(req.body);
    if (err) return bad(res, err);
    try { res.json({ persona: await store.savePersona(cleanPersona(req.body)) }); }
    catch (e) { res.status(e.code === "NOT_FOUND" ? 404 : 500).json({ error: e.message }); }
});
router.delete("/scenarios/api/personas/:id", async (req, res) => {
    // Bloqueia apagar persona referenciada por algum cenário.
    const scenarios = await store.listScenarios();
    const used = scenarios.filter(s => (s.participants || []).some(p => p.persona_id === req.params.id));
    if (used.length) return bad(res, `persona em uso por: ${used.map(s => s.name).join(", ")}`);
    await store.deletePersona(req.params.id);
    res.json({ ok: true });
});

// ---- Cenários ----
async function validateScenario(b) {
    if (!b || typeof b !== "object") return "cenário inválido";
    if (typeof b.name !== "string" || !b.name.trim()) return "nome do cenário é obrigatório";
    if (!OBJECTIVE_TYPES.includes(b.objective_type)) return "objetivo inválido";
    if (!INTERACTION_MODES.includes(b.interaction_mode)) return "modo de interação inválido";
    const parts = Array.isArray(b.participants) ? b.participants : [];
    if (parts.length === 0) return "inclua ao menos uma persona";
    const personas = await store.listPersonas();
    const ids = new Set(personas.map(p => p.id));
    for (const p of parts) {
        if (!ids.has(p.persona_id)) return "participante referencia persona inexistente";
        if (!PARTICIPANT_ROLES.includes(p.role)) return "papel de participante inválido";
    }
    return null;
}
function cleanScenario(b) {
    return {
        ...(b.id ? { id: b.id } : {}),
        name: b.name.trim(),
        objective_type: b.objective_type,
        context: typeof b.context === "string" ? b.context.trim() : "",
        student_task: typeof b.student_task === "string" ? b.student_task.trim() : "",
        interaction_mode: b.interaction_mode,
        participants: b.participants.map(p => ({ persona_id: p.persona_id, role: p.role })),
        persona_exchange: !!b.persona_exchange,
        opener_persona_id: b.opener_persona_id || b.participants[0]?.persona_id || null,
    };
}

router.get("/scenarios/api/scenarios", async (_req, res) => {
    const [scenarios, personas] = await Promise.all([store.listScenarios(), store.listPersonas()]);
    const byId = new Map(personas.map(p => [p.id, p]));
    // Enriquecimento para a UI: nomes/ícones das personas referenciadas.
    const enriched = scenarios.map(s => ({
        ...s,
        participant_personas: (s.participants || []).map(p => ({ ...p, persona: byId.get(p.persona_id) || null })),
    }));
    res.json({ scenarios: enriched });
});
router.post("/scenarios/api/scenarios", json, async (req, res) => {
    const err = await validateScenario(req.body);
    if (err) return bad(res, err);
    try { res.json({ scenario: await store.saveScenario(cleanScenario(req.body)) }); }
    catch (e) { res.status(e.code === "NOT_FOUND" ? 404 : 500).json({ error: e.message }); }
});
router.delete("/scenarios/api/scenarios/:id", async (req, res) => {
    await store.deleteScenario(req.params.id);
    res.json({ ok: true });
});

// ---- Execução MOCK ----
async function personasByIdFor(scenario) {
    const personas = await store.listPersonas();
    const byId = {};
    for (const p of scenario.participants || []) {
        const persona = personas.find(x => x.id === p.persona_id);
        if (persona) byId[persona.id] = persona;
    }
    return byId;
}

// Inicia uma execução: cria o run e devolve os turnos de abertura.
router.post("/scenarios/api/run/:scenarioId/start", async (req, res) => {
    const scenario = await store.getScenario(req.params.scenarioId);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const byId = await personasByIdFor(scenario);
    const run = await store.createRun(scenario.id);
    run.transcript = openingTurns(scenario, byId);
    await store.saveRun(run);
    res.json({ run, scenario });
});

// Turno do aluno → próximos turnos das personas (mock).
router.post("/scenarios/api/run/:runId/turn", json, async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return bad(res, "mensagem vazia");
    const scenario = await store.getScenario(run.scenario_id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const byId = await personasByIdFor(scenario);
    run.transcript.push({ speaker: "student", kind: "student", text });
    const replies = respond(scenario, byId, run.transcript, text);
    run.transcript.push(...replies);
    run.turn = (run.turn || 0) + 1;
    await store.saveRun(run);
    res.json({ replies, run });
});

export default router;

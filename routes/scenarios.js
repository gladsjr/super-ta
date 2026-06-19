// API do sistema de CENÁRIOS MULTIAGENTE (fase mock).
//
// Duas camadas de definição, claramente distintas:
//   TEMPLATE   — persona reutilizável (biblioteca), definição completa, com voz
//                e gênero. Não é referenciada direto pelas interações.
//   CENÁRIO    — explicação geral + PDF + PERSONAS escolhidas (cópias editáveis
//                de templates ou criadas do zero) + sequência ORDENADA de
//                interações que apontam para essas personas.
//   INTERAÇÃO  — aluno↔persona(s) ou persona↔persona.
//
// Sem LLM nem Postgres (store JSON). Sem auth nesta fase — protótipo; antes de
// produção, gatear (requireAdmin) e migrar para o banco.

import express from "express";
import { randomUUID } from "crypto";
import * as store from "../lib/scenarios/store.js";
import { VOICES } from "../config/voices.js";
import {
    scenarioFrame, interactionStart, respond, evaluatePdfMock,
    OBJECTIVE_TYPES, PARTICIPANT_ROLES, INTERACTION_KINDS, objectiveLabel, ROLE_LABEL,
} from "../lib/scenarios/mockEngine.js";

const router = express.Router();
const json = express.json({ limit: "256kb" });
const bad = (res, msg) => res.status(400).json({ error: msg });
const str = x => (typeof x === "string" ? x.trim() : "");
const lines = x => Array.isArray(x) ? x.map(s => String(s).trim()).filter(Boolean) : [];

const GENDERS = ["masculino", "feminino", "neutro"];
const VOICE_IDS = new Set(VOICES.map(v => v.id));
const cpId = () => `cp_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

// ---- Meta (enums para a UI) ----
router.get("/scenarios/api/meta", (_req, res) => {
    res.json({
        objective_types: OBJECTIVE_TYPES.map(v => ({ value: v, label: objectiveLabel(v) })),
        participant_roles: PARTICIPANT_ROLES.map(v => ({ value: v, label: ROLE_LABEL[v] || v })),
        interaction_kinds: INTERACTION_KINDS.map(v => ({ value: v, label: v === "student" ? "Aluno ↔ persona(s)" : "Persona ↔ persona" })),
        genders: GENDERS.map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
        voices: VOICES.map(v => ({ value: v.id, label: v.label, gender: v.gender })),
    });
});

// ---- Assistente do professor (propõe; não salva) ----
router.post("/scenarios/api/assistant", json, async (req, res) => {
    const message = str(req.body?.message);
    if (!message) return bad(res, "mensagem vazia");
    try {
        const { scenarioAssistantAgent } = await import("../lib/agents.js");
        const templates = (await store.listTemplates()).map(t => ({ name: t.name, role: t.role }));
        const out = await scenarioAssistantAgent.chat({
            scenario: req.body?.scenario || {},
            templates,
            history: Array.isArray(req.body?.history) ? req.body.history : [],
            message,
            meterCtx: {},
        });
        res.json(out);
    } catch (e) { res.status(500).json({ error: `assistente indisponível: ${e.message}` }); }
});

// ---- Persona (definição rica; serve a template e a persona-do-cenário) ----
function validatePersona(b) {
    if (!b || typeof b !== "object") return "persona inválida";
    if (!str(b.name)) return "nome é obrigatório";
    if (!str(b.role)) return "papel é obrigatório";
    return null;
}
function cleanPersona(b, { keepId = true } = {}) {
    const k = b.knowledge && typeof b.knowledge === "object" ? b.knowledge : {};
    return {
        ...(keepId && b.id ? { id: b.id } : {}),
        ...(b.template_id ? { template_id: b.template_id } : {}),
        name: str(b.name),
        icon: str(b.icon) || "🧑",
        role: str(b.role),
        gender: GENDERS.includes(b.gender) ? b.gender : "",
        voice: VOICE_IDS.has(b.voice) ? b.voice : "",
        description: str(b.description), authority: str(b.authority), tone: str(b.tone),
        objectives: lines(b.objectives), concerns: lines(b.concerns),
        decision_criteria: lines(b.decision_criteria), constraints: lines(b.constraints),
        information_needs: lines(b.information_needs), evaluation_mode: lines(b.evaluation_mode),
        knowledge: {
            scope: lines(k.scope),
            assets: Array.isArray(k.assets) ? k.assets.filter(a => a && a.label).map(a => ({ type: str(a.type) || "document", label: str(a.label) })) : [],
            level: str(k.level),
        },
        example_questions: lines(b.example_questions),
    };
}

// ---- Templates (biblioteca) ----
router.get("/scenarios/api/templates", async (_req, res) => res.json({ templates: await store.listTemplates() }));
router.post("/scenarios/api/templates", json, async (req, res) => {
    const err = validatePersona(req.body);
    if (err) return bad(res, err);
    try { res.json({ template: await store.saveTemplate(cleanPersona(req.body)) }); }
    catch (e) { res.status(e.code === "NOT_FOUND" ? 404 : 500).json({ error: e.message }); }
});
// Templates podem ser excluídos livremente: as personas do cenário são CÓPIAS,
// então apagar um template não quebra cenário algum.
router.delete("/scenarios/api/templates/:id", async (req, res) => { await store.deleteTemplate(req.params.id); res.json({ ok: true }); });

// ---- Cenário (personas escolhidas + interações ordenadas) ----
function validateScenario(b) {
    if (!b || typeof b !== "object") return "cenário inválido";
    if (!str(b.name)) return "nome do cenário é obrigatório";
    const personas = Array.isArray(b.personas) ? b.personas : [];
    for (const p of personas) {
        const e = validatePersona(p);
        if (e) return `persona do cenário: ${e}`;
    }
    const ids = new Set(personas.map(p => p.id).filter(Boolean));
    const its = Array.isArray(b.interactions) ? b.interactions : [];
    if (its.length === 0) return "inclua ao menos uma interação";
    for (const it of its) {
        if (!str(it.title)) return "toda interação precisa de um título";
        if (!INTERACTION_KINDS.includes(it.kind)) return "tipo de interação inválido";
        if (!OBJECTIVE_TYPES.includes(it.objective_type)) return `objetivo inválido na interação "${it.title}"`;
        const parts = Array.isArray(it.participants) ? it.participants : [];
        if (it.kind === "persona_exchange") {
            if (parts.length !== 2) return `"${it.title}": persona↔persona precisa de exatamente 2 personas`;
            if (parts[0].persona_id === parts[1].persona_id) return `"${it.title}": as duas personas devem ser diferentes`;
        } else {
            if (parts.length === 0) return `"${it.title}": inclua ao menos uma persona`;
        }
        for (const p of parts) {
            if (!ids.has(p.persona_id)) return `"${it.title}": escolha personas do cenário`;
            if (it.kind === "student" && !PARTICIPANT_ROLES.includes(p.role)) return `"${it.title}": papel inválido`;
        }
    }
    return null;
}
function cleanInteraction(it, i) {
    const parts = (it.participants || []).map(p => ({ persona_id: p.persona_id, role: PARTICIPANT_ROLES.includes(p.role) ? p.role : "questionamento" }));
    return {
        id: str(it.id) || `i_${i}_${randomUUID().slice(0, 6)}`,
        title: str(it.title),
        kind: it.kind,
        objective_type: it.objective_type,
        participants: parts,
        opener_persona_id: it.opener_persona_id || parts[0]?.persona_id || null,
        focus: it.kind === "persona_exchange" ? str(it.focus) : "",
        instruction: str(it.instruction),
        example_questions: lines(it.example_questions),
    };
}
function cleanScenario(b) {
    // pdf/coherence NÃO entram aqui — o merge no store preserva o que os
    // endpoints de PDF gravaram.
    const personas = (Array.isArray(b.personas) ? b.personas : []).map(p => {
        const c = cleanPersona(p);
        if (!c.id) c.id = cpId();
        return c;
    });
    return {
        ...(b.id ? { id: b.id } : {}),
        name: str(b.name),
        description: str(b.description),
        personas,
        interactions: (Array.isArray(b.interactions) ? b.interactions : []).map(cleanInteraction),
    };
}
function personasById(scenario) {
    const byId = {};
    for (const p of scenario.personas || []) byId[p.id] = p;
    return byId;
}
function enrich(scenario) {
    const byId = personasById(scenario);
    return {
        ...scenario,
        interactions: (scenario.interactions || []).map(it => ({
            ...it,
            participant_personas: (it.participants || []).map(p => ({ ...p, persona: byId[p.persona_id] || null })),
        })),
    };
}

router.get("/scenarios/api/scenarios", async (_req, res) => {
    const scenarios = await store.listScenarios();
    res.json({ scenarios: scenarios.map(enrich) });
});
router.post("/scenarios/api/scenarios", json, async (req, res) => {
    const err = validateScenario(req.body);
    if (err) return bad(res, err);
    try { res.json({ scenario: enrich(await store.saveScenario(cleanScenario(req.body))) }); }
    catch (e) { res.status(e.code === "NOT_FOUND" ? 404 : 500).json({ error: e.message }); }
});
router.delete("/scenarios/api/scenarios/:id", async (req, res) => { await store.deleteScenario(req.params.id); res.json({ ok: true }); });

// ---- PDF (a posteriori) + avaliação de coerência (mock) ----
router.post("/scenarios/api/scenarios/:id/pdf", json, async (req, res) => {
    const s = await store.getScenario(req.params.id);
    if (!s) return res.status(404).json({ error: "cenário não encontrado" });
    const filename = str(req.body?.filename) || "enunciado.pdf";
    const saved = await store.saveScenario({ id: s.id, pdf: { filename, uploaded_at: new Date().toISOString() }, coherence: null });
    res.json({ scenario: enrich(saved) });
});
router.post("/scenarios/api/scenarios/:id/pdf/evaluate", async (req, res) => {
    const s = await store.getScenario(req.params.id);
    if (!s) return res.status(404).json({ error: "cenário não encontrado" });
    if (!s.pdf) return bad(res, "anexe um PDF antes de avaliar");
    const coherence = { ...evaluatePdfMock(s), evaluated_at: new Date().toISOString() };
    const saved = await store.saveScenario({ id: s.id, coherence });
    res.json({ scenario: enrich(saved), coherence });
});

// ---- Execução: MOCK (roteirizado, zero token) ou LIVE (ScenarioOrchestrator) ----
// O modo é escolhido por ?mode=live. O agente e o liveEngine são importados sob
// demanda (lazy) — assim o servidor DB-free de preview sobe sem precisar de chave
// OpenAI enquanto só o mock for usado.
const isLive = req => req.query?.mode === "live";
async function liveDeps() {
    const [agentsMod, live] = await Promise.all([
        import("../lib/agents.js"),
        import("../lib/scenarios/liveEngine.js"),
    ]);
    return { agent: agentsMod.scenarioOrchestratorAgent, live };
}

router.post("/scenarios/api/run/:scenarioId/start", async (req, res) => {
    const scenario = await store.getScenario(req.params.scenarioId);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    if (!(scenario.interactions || []).length) return bad(res, "cenário sem interações");
    const byId = personasById(scenario);
    const total = scenario.interactions.length;
    const run = await store.createRun(scenario.id);
    run.interaction_index = 0;
    run.mode = isLive(req) ? "live" : "mock";
    run.memory = null;
    try {
        if (run.mode === "live") {
            const { agent, live } = await liveDeps();
            run.transcript = [live.scenarioFrame(scenario), ...(await live.interactionStartLive(agent, { scenario, interaction: scenario.interactions[0], personasById: byId, idx: 0, total, runMemory: "", meterCtx: {} }))];
        } else {
            run.transcript = [scenarioFrame(scenario), ...interactionStart(scenario.interactions[0], byId, 0, total)];
        }
    } catch (e) { return res.status(500).json({ error: `falha ao iniciar (${run.mode}): ${e.message}` }); }
    await store.saveRun(run);
    res.json({ run, scenario: enrich(scenario) });
});
router.post("/scenarios/api/run/:runId/turn", json, async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const text = str(req.body?.text);
    if (!text) return bad(res, "mensagem vazia");
    const scenario = await store.getScenario(run.scenario_id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const it = scenario.interactions[run.interaction_index];
    if (!it || it.kind !== "student") return bad(res, "esta etapa não aceita resposta do aluno — avance");
    const byId = personasById(scenario);
    run.transcript.push({ speaker: "student", kind: "student", text });
    try {
        if (run.mode === "live") {
            const { agent, live } = await liveDeps();
            const r = await live.respondLive(agent, { scenario, interaction: it, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, transcript: run.transcript, memory: run.memory, meterCtx: {} });
            run.memory = r.memory ?? run.memory;
            run.transcript.push(...r.entries);
            run.last_action = r.action?.kind || "speak";
            await store.saveRun(run);
            return res.json({ run, action: r.action || null });
        }
        run.transcript.push(...respond(it, byId, run.transcript, text));
    } catch (e) { return res.status(500).json({ error: `falha no turno (live): ${e.message}` }); }
    await store.saveRun(run);
    res.json({ run });
});
router.post("/scenarios/api/run/:runId/advance", async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const scenario = await store.getScenario(run.scenario_id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const total = scenario.interactions.length;
    const next = (run.interaction_index ?? 0) + 1;
    if (next >= total) {
        run.transcript.push({ speaker: "system", kind: "scenario", text: "✓ Fim do cenário — todas as interações foram percorridas." });
        run.interaction_index = total;
        await store.saveRun(run);
        return res.json({ run, done: true });
    }
    const byId = personasById(scenario);
    run.interaction_index = next;
    run.memory = null;
    try {
        if (run.mode === "live") {
            const { agent, live } = await liveDeps();
            const runMemory = live.buildRunMemory(scenario, run.transcript, next);
            run.transcript.push(...(await live.interactionStartLive(agent, { scenario, interaction: scenario.interactions[next], personasById: byId, idx: next, total, runMemory, meterCtx: {} })));
        } else {
            run.transcript.push(...interactionStart(scenario.interactions[next], byId, next, total));
        }
    } catch (e) { return res.status(500).json({ error: `falha ao avançar (live): ${e.message}` }); }
    await store.saveRun(run);
    res.json({ run, done: false });
});

// ---- Avaliação interna + notas de um run (professor; persistem no run) ----
router.post("/scenarios/api/run/:runId/evaluate", async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const scenario = await store.getScenario(run.scenario_id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    try {
        const { scenarioEvaluatorAgent } = await import("../lib/agents.js");
        const evaluation = await scenarioEvaluatorAgent.evaluate({ scenario: enrich(scenario), transcript: run.transcript, meterCtx: {} });
        run.evaluation_json = evaluation;
        await store.saveRun(run);
        res.json({ evaluation });
    } catch (e) { res.status(500).json({ error: `falha na avaliação: ${e.message}` }); }
});
router.post("/scenarios/api/run/:runId/grades", json, async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    if (!run.evaluation_json) return bad(res, "avalie o run antes de calcular as notas");
    try {
        const { gradingAgent } = await import("../lib/agents.js");
        const { DEFAULT_RUBRIC, weightedFinal } = await import("../lib/rubric.js");
        const rubric = Array.isArray(req.body?.rubric) && req.body.rubric.length ? req.body.rubric : DEFAULT_RUBRIC;
        const scored = [];
        for (const c of rubric) {
            const g = await gradingAgent.grade({ internalReport: run.evaluation_json, criterion: c, meterCtx: {} });
            scored.push({ id: c.id, name: c.name, weight: c.weight, ...g });
        }
        const grades = { criteria: scored, final: weightedFinal(scored.filter(s => s.score != null)), computed_at: new Date().toISOString() };
        run.grades_json = grades;
        await store.saveRun(run);
        res.json({ grades });
    } catch (e) { res.status(500).json({ error: `falha nas notas: ${e.message}` }); }
});
// Devolutiva FORMATIVA ao aluno (reusa o StudentFeedbackAgent sobre o relatório
// do cenário). per_question:[] satisfaz a validação do agente (que é tunada para
// o relatório de entrevista single) sem que ela rejeite feedback do cenário.
router.post("/scenarios/api/run/:runId/devolutiva", json, async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    if (!run.evaluation_json) return bad(res, "avalie o run antes de gerar a devolutiva");
    try {
        const { studentFeedbackAgent } = await import("../lib/agents.js");
        const report = { per_question: [], ...run.evaluation_json };
        const devolutiva = await studentFeedbackAgent.derive({ internalReport: report, guidelines: str(req.body?.guidelines) || null, meterCtx: {} });
        res.json({ devolutiva });
    } catch (e) { res.status(500).json({ error: `falha na devolutiva: ${e.message}` }); }
});

export default router;

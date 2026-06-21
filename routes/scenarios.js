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
import multer from "multer";
import OpenAI from "openai";
import { randomUUID } from "crypto";
import * as store from "../lib/scenarios/store.js";
import * as db from "../lib/db.js";
import { requireAdmin } from "../lib/middleware.js";
import { scenarioToYaml, personaToYaml, parseYaml } from "../lib/scenarios/scenarioYaml.js";
import { FORMS, FORM_LABELS, FORM_DEFAULT_WORK, formKind, normalizeForm } from "../lib/scenarios/interactionForms.js";
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
        forms: FORMS.map(v => ({ value: v, label: FORM_LABELS[v], default_work: !!FORM_DEFAULT_WORK[v], kind: formKind(v) })),
        objective_types: OBJECTIVE_TYPES.map(v => ({ value: v, label: objectiveLabel(v) })),
        participant_roles: PARTICIPANT_ROLES.map(v => ({ value: v, label: ROLE_LABEL[v] || v })),
        interaction_kinds: INTERACTION_KINDS.map(v => ({ value: v, label: v === "student" ? "Aluno ↔ persona(s)" : "Persona ↔ persona" })),
        genders: GENDERS.map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
        voices: VOICES.map(v => ({ value: v.id, label: v.label, gender: v.gender })),
    });
});

// ---- Import/export YAML (cenário inteiro OU persona isolada) — stateless ----
// Conversores puros (sem banco); servem o estúdio inline e o standalone. O YAML
// é só uma ponte: o objeto continua sendo o formato canônico (form + JSONB).
router.post("/scenarios/api/yaml/to", json, (req, res) => {
    try {
        if (req.body?.persona) return res.json({ yaml: personaToYaml(req.body.persona) });
        if (req.body?.scenario) return res.json({ yaml: scenarioToYaml(req.body.scenario) });
        return bad(res, "envie { scenario } ou { persona }");
    } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/scenarios/api/yaml/from", json, (req, res) => {
    const text = str(req.body?.yaml);
    if (!text) return bad(res, "cole um YAML");
    try { res.json(parseYaml(text)); }
    catch (e) { bad(res, e.message); }
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
        const form = normalizeForm(it);          // aceita form novo ou objective_type/kind legado
        if (!FORMS.includes(form)) return `forma inválida na interação "${it.title}"`;
        if (form === "custom" && !str(it.form_prompt)) return `"${it.title}": a forma personalizada exige um prompt`;
        if (it.time_limit_min != null && (typeof it.time_limit_min !== "number" || !(it.time_limit_min > 0))) return `"${it.title}": o tempo (min) deve ser um número positivo`;
        const kind = formKind(form);
        const parts = Array.isArray(it.participants) ? it.participants : [];
        if (kind === "persona_exchange") {
            if (parts.length !== 2) return `"${it.title}": deliberação entre personas precisa de exatamente 2 personas`;
            if (parts[0].persona_id === parts[1].persona_id) return `"${it.title}": as duas personas devem ser diferentes`;
        } else {
            if (parts.length === 0) return `"${it.title}": inclua ao menos uma persona`;
        }
        for (const p of parts) {
            if (!ids.has(p.persona_id)) return `"${it.title}": escolha personas do cenário`;
            if (kind === "student" && !PARTICIPANT_ROLES.includes(p.role)) return `"${it.title}": papel inválido`;
        }
    }
    return null;
}
function cleanInteraction(it, i) {
    const form = normalizeForm(it);
    const kind = formKind(form);                 // derivado da forma; gravado p/ o engine
    const parts = (it.participants || []).map(p => ({ persona_id: p.persona_id, role: PARTICIPANT_ROLES.includes(p.role) ? p.role : "questionamento" }));
    const incWork = typeof it.includes_student_work === "boolean" ? it.includes_student_work : !!FORM_DEFAULT_WORK[form];
    return {
        id: str(it.id) || `i_${i}_${randomUUID().slice(0, 6)}`,
        title: str(it.title),
        form,
        form_prompt: str(it.form_prompt),
        includes_student_work: incWork,
        kind,
        participants: parts,
        opener_persona_id: it.opener_persona_id || parts[0]?.persona_id || null,
        focus: kind === "persona_exchange" ? str(it.focus) : "",
        instruction: str(it.instruction),
        example_questions: lines(it.example_questions),
        time_limit_min: (typeof it.time_limit_min === "number" && it.time_limit_min > 0) ? Math.round(it.time_limit_min) : null,
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
        out_of_scope: str(b.out_of_scope),
        premissas: str(b.premissas),
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

// ---- Estúdio ESCOPADO A UM TRABALHO (coexistência) ----
// O estúdio global edita scenarios[0]; estas rotas o amarram a um trabalho
// específico (work_id), para o painel do professor de um trabalho multi-interação.
// requireAdmin: config do professor (o admin está logado ao configurar). O
// cenário de um trabalho 'scenario' é criado na criação do trabalho (admin.js);
// aqui fazemos get-or-create defensivo e sempre reamarramos ao work no save.
router.get("/w/:workToken/scenario", requireAdmin, async (req, res) => {
    const work = await db.getWorkByToken(String(req.params.workToken || "").toLowerCase());
    if (!work) return res.status(404).json({ error: "trabalho não encontrado" });
    let scenario = await store.getScenarioByWork(work.id);
    if (!scenario) {
        if (work.kind !== "scenario") return bad(res, "este trabalho é de entrevista (uni-interação) — não tem cenário");
        scenario = await store.saveScenario({ name: work.name, description: "", personas: [], interactions: [], work_id: work.id });
    }
    res.json({ work: { token: work.work_token, name: work.name, kind: work.kind }, scenario: enrich(scenario) });
});
router.post("/w/:workToken/scenario", requireAdmin, json, async (req, res) => {
    const work = await db.getWorkByToken(String(req.params.workToken || "").toLowerCase());
    if (!work) return res.status(404).json({ error: "trabalho não encontrado" });
    if (work.kind !== "scenario") return bad(res, "este trabalho é de entrevista — não aceita cenário");
    const err = validateScenario(req.body);
    if (err) return bad(res, err);
    try {
        const existing = await store.getScenarioByWork(work.id);
        // Sempre amarra ao work e usa o id do cenário do work (ignora id do cliente).
        const saved = await store.saveScenario({ ...cleanScenario(req.body), id: existing?.id, work_id: work.id });
        res.json({ scenario: enrich(saved) });
    } catch (e) { res.status(e.code === "NOT_FOUND" ? 404 : 500).json({ error: e.message }); }
});

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
// Upload REAL do enunciado: arquivo → OpenAI Files → vector store (file_search),
// para as personas citarem o caso. Guarda {filename, file_id, vector_store_id}.
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.post("/scenarios/api/scenarios/:id/pdf-file", pdfUpload.single("file"), async (req, res) => {
    const s = await store.getScenario(req.params.id);
    if (!s) return res.status(404).json({ error: "cenário não encontrado" });
    if (!req.file) return bad(res, "envie um arquivo no campo 'file'");
    try {
        const { openai } = await import("../lib/openaiClient.js");
        const { createVectorStoreWithFiles } = await import("../lib/sessionLifecycle.js");
        const name = req.file.originalname || "enunciado.pdf";
        const uploaded = await openai.files.create({ file: await OpenAI.toFile(req.file.buffer, name), purpose: "user_data" });
        const vectorStoreId = await createVectorStoreWithFiles([uploaded.id], s.id);
        const saved = await store.saveScenario({ id: s.id, pdf: { filename: name, file_id: uploaded.id, vector_store_id: vectorStoreId, uploaded_at: new Date().toISOString() }, coherence: null });
        res.json({ scenario: enrich(saved) });
    } catch (e) { res.status(500).json({ error: `falha no upload/vector store: ${e.message}` }); }
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
            run.transcript = [live.scenarioFrame(scenario), ...(await live.interactionStartLive(agent, { scenario, interaction: scenario.interactions[0], personasById: byId, idx: 0, total, runMemory: "", meterCtx: {}, vectorStoreId: scenario.pdf?.vector_store_id || null }))];
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
            const r = await live.respondLive(agent, { scenario, interaction: it, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, transcript: run.transcript, memory: run.memory, meterCtx: {}, vectorStoreId: scenario.pdf?.vector_store_id || null });
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
            run.transcript.push(...(await live.interactionStartLive(agent, { scenario, interaction: scenario.interactions[next], personasById: byId, idx: next, total, runMemory, meterCtx: {}, vectorStoreId: scenario.pdf?.vector_store_id || null })));
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

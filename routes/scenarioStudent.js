// Fluxo do ALUNO no sistema de cenários multi-interação.
//
// Endpoints autenticados por TOKEN DE SUBMISSÃO (requireSubmissionToken) —
// separados da config do professor (/scenarios/api/*, que é requireAdmin). O run
// é amarrado à submissão (scenario_runs.submission_id) → persistência + resume.
// Modo LIVE (ScenarioOrchestrator). Custo vai no orçamento do work (meterCtx.workId).
//
// O cenário vem do work do aluno (scenarios.work_id). A UI só recebe o necessário
// (nome/descrição + personas name/icon/role + títulos das interações); as agendas
// internas das personas ficam no servidor.

import express from "express";
import { requireSubmissionToken } from "../lib/middleware.js";
import * as store from "../lib/scenarios/store.js";

const router = express.Router();
const json = express.json({ limit: "256kb" });
const bad = (res, m) => res.status(400).json({ error: m });
const str = x => (typeof x === "string" ? x.trim() : "");

const studentScenario = (s) => ({
    id: s.id, name: s.name, description: s.description,
    personas: (s.personas || []).map(p => ({ id: p.id, name: p.name, icon: p.icon, role: p.role })),
    interactions: (s.interactions || []).map(it => ({ id: it.id, title: it.title, kind: it.kind })),
});
const personasById = (s) => { const b = {}; for (const p of s.personas || []) b[p.id] = p; return b; };
const runView = (run) => ({ id: run.id, interaction_index: run.interaction_index, transcript: run.transcript, done: !!run.done });
async function liveDeps() {
    const [a, l] = await Promise.all([import("../lib/agents.js"), import("../lib/scenarios/liveEngine.js")]);
    return { agent: a.scenarioOrchestratorAgent, live: l };
}

// Estado / resume: a página carrega isto ao entrar com o token.
router.get("/s/:submissionToken/scenario/state", requireSubmissionToken, async (req, res) => {
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.json({ has_scenario: false });
    const run = await store.getRunBySubmission(req.submission.id);
    res.json({ has_scenario: true, scenario: studentScenario(scenario), run: run ? runView(run) : null, total: (scenario.interactions || []).length });
});

// Começar (ou resumir) o cenário.
router.post("/s/:submissionToken/scenario/start", requireSubmissionToken, async (req, res) => {
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "este trabalho não tem cenário" });
    if (!(scenario.interactions || []).length) return bad(res, "cenário sem interações");
    let run = await store.getRunBySubmission(req.submission.id);
    if (run) return res.json({ run: runView(run), scenario: studentScenario(scenario), resumed: true });
    const byId = personasById(scenario);
    const { agent, live } = await liveDeps();
    run = await store.createRun(scenario.id, req.submission.id);
    run.mode = "live"; run.interaction_index = 0;
    try {
        run.transcript = [live.scenarioFrame(scenario), ...(await live.interactionStartLive(agent, {
            scenario, interaction: scenario.interactions[0], personasById: byId, idx: 0,
            total: scenario.interactions.length, runMemory: "", interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id },
        }))];
    } catch (e) { return res.status(500).json({ error: `falha ao iniciar: ${e.message}` }); }
    await store.saveRun(run);
    res.json({ run: runView(run), scenario: studentScenario(scenario), resumed: false });
});

// Turno do aluno.
router.post("/s/:submissionToken/scenario/turn", requireSubmissionToken, json, async (req, res) => {
    const text = str(req.body?.text);
    if (!text) return bad(res, "mensagem vazia");
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const it = scenario.interactions[run.interaction_index];
    if (!it || it.kind !== "student") return bad(res, "esta etapa não aceita resposta — avance");
    const byId = personasById(scenario);
    const { agent, live } = await liveDeps();
    run.transcript.push({ speaker: "student", kind: "student", text });
    try {
        const r = await live.respondLive(agent, { scenario, interaction: it, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, transcript: run.transcript, memory: run.memory, interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id } });
        run.memory = r.memory ?? run.memory;
        run.transcript.push(...r.entries);
        await store.saveRun(run);
        res.json({ run: runView(run), action: r.action || null });
    } catch (e) { return res.status(500).json({ error: `falha no turno: ${e.message}` }); }
});

// Avançar para a próxima interação.
router.post("/s/:submissionToken/scenario/advance", requireSubmissionToken, async (req, res) => {
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const total = scenario.interactions.length;
    const next = (run.interaction_index ?? 0) + 1;
    if (next >= total) {
        run.transcript.push({ speaker: "system", kind: "scenario", text: "✓ Fim do cenário — todas as interações foram percorridas." });
        run.interaction_index = total; run.done = true;
        await store.saveRun(run);
        return res.json({ run: runView(run), done: true });
    }
    const byId = personasById(scenario);
    const { agent, live } = await liveDeps();
    run.interaction_index = next; run.memory = null;
    try {
        const runMemory = live.buildRunMemory(scenario, run.transcript, next);
        run.transcript.push(...(await live.interactionStartLive(agent, { scenario, interaction: scenario.interactions[next], personasById: byId, idx: next, total, runMemory, interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id } })));
    } catch (e) { return res.status(500).json({ error: `falha ao avançar: ${e.message}` }); }
    await store.saveRun(run);
    res.json({ run: runView(run), done: false });
});

export default router;

// Cockpit do PROFESSOR para trabalhos de CENÁRIO (multi-interação) — LOTE-FIRST.
//
// Cópia ISOLADA da maquinaria de lote da entrevista (routes/work.js), adaptada
// para operar sobre os `scenario_runs` de um trabalho e reusar os AGENTES de
// cenário (ScenarioEvaluator por persona, GradingAgent, StudentFeedback). Não
// toca o cockpit da entrevista (que está em produção). Gerar e Publicar são
// SEPARADOS: gera em lote → confere (visão só-leitura) → publica em lote.
//
// Rotas (todas requireAdmin + trabalho kind='scenario'):
//   GET  /w/:t/scenario-runs                      — lista runs + status/flags
//   GET  /w/:t/scenario-runs/:subToken            — um run completo (visão só-leitura)
//   POST /w/:t/scenario-runs/:subToken/{evaluate,devolutiva,grades} — refazer 1
//   POST /w/:t/scenario-evaluations               — avaliar todos (por persona)
//   POST /w/:t/scenario-evaluations/devolutivas   — gerar devolutivas
//   POST /w/:t/scenario-evaluations/grades        — calcular notas (rúbrica do work)
//   POST /w/:t/scenario-evaluations/{publish,unpublish,grade-publish,grade-unpublish}
//   GET  /w/:t/scenario-evaluations/status        — progresso dos lotes

import express from "express";
import log from "../lib/logger.js";
import { requireAdmin } from "../lib/middleware.js";
import { isWorkBudgetExceeded } from "../lib/billing.js";
import { parseStoredRubric, weightedFinal, DEFAULT_RUBRIC } from "../lib/rubric.js";
import * as db from "../lib/db.js";
import * as store from "../lib/scenarios/store.js";

const router = express.Router();
const bad = (res, m) => res.status(400).json({ error: m });
const str = x => (typeof x === "string" ? x.trim() : "");

// Resolve o trabalho e exige que seja de cenário. Roda depois de requireAdmin.
async function requireScenarioWork(req, res, next) {
    const work = await db.getWorkByToken(String(req.params.workToken || "").toLowerCase());
    if (!work) return res.status(404).json({ error: "trabalho não encontrado" });
    if (work.kind !== "scenario") return bad(res, "este trabalho não é de cenário");
    req.work = work;
    next();
}
const A = [requireAdmin, requireScenarioWork];

// Agentes (singletons) sob demanda, como no resto do subsistema de cenário.
async function agents() { return import("../lib/agents.js"); }
// Carrega o run mais recente da submissão de uma linha da lista.
async function loadRun(subToken, workId) {
    const sub = await db.findSubmissionByToken(String(subToken).toLowerCase());
    if (!sub || sub.work_id !== workId) return { sub: null, run: null };
    return { sub, run: await store.getRunBySubmission(sub.id) };
}

// ---- Operações por run (reusadas tanto no lote quanto no "refazer 1") ----
async function doEvaluate(run, workId) {
    const scenario = await store.getScenario(run.scenario_id);
    const { scenarioEvaluatorAgent } = await agents();
    run.evaluation_json = await scenarioEvaluatorAgent.evaluate({ scenario, transcript: run.transcript, meterCtx: { workId } });
    await store.saveRun(run);
    return run.evaluation_json;
}
async function doDevolutiva(run, work, guidelines) {
    // per_question:[] satisfaz a validação do StudentFeedbackAgent (tunado p/ a
    // entrevista) sem rejeitar o relatório do cenário (por persona).
    const report = { per_question: [], ...run.evaluation_json };
    const visibleSections = {
        strengths: work.include_strengths !== false,
        improvement_areas: work.include_improvement_areas !== false,
        study_suggestions: work.include_study_suggestions !== false,
    };
    const { studentFeedbackAgent } = await agents();
    run.devolutiva_json = await studentFeedbackAgent.derive({
        internalReport: report, guidelines: guidelines || work.feedback_guidelines || null,
        visibleSections, meterCtx: { workId: work.id },
    });
    await store.saveRun(run);
    return run.devolutiva_json;
}
async function doGrades(run, work) {
    const rubric = parseStoredRubric(work.grading_rubric) || DEFAULT_RUBRIC;
    const { gradingAgent } = await agents();
    const scored = [];
    for (const c of rubric) {
        const g = await gradingAgent.grade({ internalReport: run.evaluation_json, criterion: c, meterCtx: { workId: work.id } });
        scored.push({ id: c.id, name: c.name, weight: c.weight, ...g });
    }
    run.grades_json = { criteria: scored, final: weightedFinal(scored.filter(s => s.score != null)), computed_at: new Date().toISOString() };
    await store.saveRun(run);
    return run.grades_json;
}

// ---- Maquinaria de LOTE (espelha routes/work.js: estado em memória + runner) ----
const batches = new Map();                 // `${workId}:${scope}` -> estado
const key = (workId, scope) => `${workId}:${scope}`;
const newState = (force, total) => ({ running: true, force, total, done: 0, ok: 0, skipped: 0, failed: [], stopped_reason: null, started_at: new Date().toISOString(), finished_at: null });
function pub(s) { if (!s) return null; const { running, force, total, done, ok, skipped, failed, stopped_reason, started_at, finished_at } = s; return { running, force, total, done, ok, skipped, failed, stopped_reason, started_at, finished_at }; }
function anyRunning(workId) { for (const [k, s] of batches) if (k.startsWith(`${workId}:`) && s.running) return true; return false; }

async function runBatch(scope, work, queue, state, itemFn, { checkBudget }) {
    log.info("SCEN_COCKPIT", `batch ${scope} start work=${work.work_token} total=${queue.length} force=${state.force}`);
    for (const row of queue) {
        try {
            if (checkBudget && await isWorkBudgetExceeded(work.id)) { state.stopped_reason = "budget_exhausted"; break; }
            const r = await itemFn(row);
            if (r?.skipped) state.skipped++; else state.ok++;
        } catch (err) {
            if (err.notReady) state.skipped++;
            else { state.failed.push({ submission_token: row.submission_token, student_label: row.student_label, error: err.message }); log.error("SCEN_COCKPIT", `batch ${scope} item ${row.submission_token}: ${err.message}`); }
        } finally { state.done++; }
    }
    state.running = false; state.finished_at = new Date().toISOString();
    log.info("SCEN_COCKPIT", `batch ${scope} done work=${work.work_token} ok=${state.ok} skipped=${state.skipped} failed=${state.failed.length} stopped=${state.stopped_reason ?? "-"}`);
}

function batchRoute({ scope, queueFilter, emptyError, makeItem, checkBudget }) {
    return async (req, res) => {
        const work = req.work, force = req.body?.force === true;
        if (anyRunning(work.id)) return res.status(409).json({ error: "já existe um lote em andamento para este trabalho" });
        if (checkBudget && await isWorkBudgetExceeded(work.id)) return res.status(402).json({ error: "orçamento do trabalho esgotado" });
        const rows = await store.listScenarioRunsForWork(work.id);
        const queue = rows.filter(r => queueFilter(r, force));
        if (!queue.length) return bad(res, emptyError(force));
        const state = newState(force, queue.length);
        batches.set(key(work.id, scope), state);
        runBatch(scope, work, queue, state, makeItem(work, force), { checkBudget })
            .catch(err => { log.error("SCEN_COCKPIT", `batch ${scope} crashed: ${err.message}`); state.running = false; state.finished_at = new Date().toISOString(); });
        res.json({ started: true, total: queue.length, force });
    };
}

// itemFn factories (sempre (work, force) -> async (row) -> {skipped?}).
const evalItem = (work, force) => async (row) => {
    if (!row.run_id || !(row.student_turns > 0)) return { skipped: true };
    if (row.has_evaluation && !force) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id);
    if (!run || !(run.transcript || []).some(e => e.kind === "student")) { const e = new Error("sem conversa do aluno"); e.notReady = true; throw e; }
    await doEvaluate(run, work.id);
};
const devolutivaItem = (work, force) => async (row) => {
    if (!row.has_evaluation) return { skipped: true };
    if (row.has_devolutiva && !force) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id);
    if (!run?.evaluation_json) { const e = new Error("sem avaliação"); e.notReady = true; throw e; }
    await doDevolutiva(run, work, null);
};
const gradeItem = (work, force) => async (row) => {
    if (!row.has_evaluation) return { skipped: true };
    if (row.has_grades && !force) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id);
    if (!run?.evaluation_json) { const e = new Error("sem avaliação"); e.notReady = true; throw e; }
    await doGrades(run, work);
};
const publishItem = (work, force) => async (row) => {
    if (!row.has_devolutiva) return { skipped: true };
    if (row.evaluation_published_at && !force) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id);
    if (!run?.devolutiva_json) return { skipped: true };
    run.evaluation_published_at = new Date().toISOString(); await store.saveRun(run);
};
const unpublishItem = (work) => async (row) => {
    if (!row.evaluation_published_at) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id); if (!run) return { skipped: true };
    run.evaluation_published_at = null; await store.saveRun(run);
};
const gradePublishItem = (work, force) => async (row) => {
    if (!row.has_grades) return { skipped: true };
    if (row.grade_published_at && !force) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id);
    if (!run?.grades_json) return { skipped: true };
    run.grade_published_at = new Date().toISOString(); await store.saveRun(run);
};
const gradeUnpublishItem = (work) => async (row) => {
    if (!row.grade_published_at) return { skipped: true };
    const { run } = await loadRun(row.submission_token, work.id); if (!run) return { skipped: true };
    run.grade_published_at = null; await store.saveRun(run);
};

// ---- Listagem + visão por aluno (só-leitura) ----
router.get("/w/:workToken/scenario-runs", ...A, async (req, res) => {
    res.json({ runs: await store.listScenarioRunsForWork(req.work.id) });
});
router.get("/w/:workToken/scenario-runs/:subToken", ...A, async (req, res) => {
    const { sub, run } = await loadRun(req.params.subToken, req.work.id);
    if (!sub) return res.status(404).json({ error: "submissão não encontrada" });
    if (!run) return res.json({ label: sub.student_label, run: null });
    const scenario = await store.getScenario(run.scenario_id);
    res.json({
        label: sub.student_label,
        scenario: {
            name: scenario?.name,
            personas: (scenario?.personas || []).map(p => ({ id: p.id, name: p.name, icon: p.icon, role: p.role })),
            interactions: (scenario?.interactions || []).map(it => ({ id: it.id, title: it.title, kind: it.kind })),
        },
        transcript: run.transcript,
        evaluation: run.evaluation_json, devolutiva: run.devolutiva_json, grades: run.grades_json,
        evaluation_published_at: run.evaluation_published_at, grade_published_at: run.grade_published_at,
    });
});

// ---- Refazer UM run (outliers) ----
router.post("/w/:workToken/scenario-runs/:subToken/evaluate", ...A, async (req, res) => {
    try {
        const { sub, run } = await loadRun(req.params.subToken, req.work.id);
        if (!sub || !run) return res.status(404).json({ error: "run não encontrado" });
        res.json({ evaluation: await doEvaluate(run, req.work.id) });
    } catch (e) { res.status(500).json({ error: `falha na avaliação: ${e.message}` }); }
});
router.post("/w/:workToken/scenario-runs/:subToken/devolutiva", ...A, async (req, res) => {
    try {
        const { sub, run } = await loadRun(req.params.subToken, req.work.id);
        if (!sub || !run) return res.status(404).json({ error: "run não encontrado" });
        if (!run.evaluation_json) return bad(res, "avalie o run antes de gerar a devolutiva");
        res.json({ devolutiva: await doDevolutiva(run, req.work, str(req.body?.guidelines) || null) });
    } catch (e) { res.status(500).json({ error: `falha na devolutiva: ${e.message}` }); }
});
router.post("/w/:workToken/scenario-runs/:subToken/grades", ...A, async (req, res) => {
    try {
        const { sub, run } = await loadRun(req.params.subToken, req.work.id);
        if (!sub || !run) return res.status(404).json({ error: "run não encontrado" });
        if (!run.evaluation_json) return bad(res, "avalie o run antes de calcular as notas");
        res.json({ grades: await doGrades(run, req.work) });
    } catch (e) { res.status(500).json({ error: `falha nas notas: ${e.message}` }); }
});

// ---- Lotes: GERAR ----
router.post("/w/:workToken/scenario-evaluations", ...A, batchRoute({
    scope: "eval", checkBudget: true, makeItem: evalItem,
    queueFilter: (r, f) => r.run_id && r.student_turns > 0 && (f || !r.has_evaluation),
    emptyError: f => f ? "nenhum run com conversa para avaliar" : "nenhum run novo para avaliar — todos os elegíveis já têm avaliação",
}));
router.post("/w/:workToken/scenario-evaluations/devolutivas", ...A, batchRoute({
    scope: "devolutiva", checkBudget: true, makeItem: devolutivaItem,
    queueFilter: (r, f) => r.has_evaluation && (f || !r.has_devolutiva),
    emptyError: f => f ? "nenhum run avaliado para gerar devolutiva" : "nenhuma devolutiva nova — todos os avaliados já têm devolutiva",
}));
router.post("/w/:workToken/scenario-evaluations/grades", ...A, batchRoute({
    scope: "grade", checkBudget: true, makeItem: gradeItem,
    queueFilter: (r, f) => r.has_evaluation && (f || !r.has_grades),
    emptyError: f => f ? "nenhum run avaliado para calcular nota" : "nenhuma nota nova — todos os avaliados já têm nota",
}));
// ---- Lotes: PUBLICAR (Fase 2; sem custo de LLM) ----
router.post("/w/:workToken/scenario-evaluations/publish", ...A, batchRoute({
    scope: "publish", checkBudget: false, makeItem: publishItem,
    queueFilter: (r, f) => r.has_devolutiva && (f || !r.evaluation_published_at),
    emptyError: () => "nenhuma devolutiva pronta para publicar",
}));
router.post("/w/:workToken/scenario-evaluations/unpublish", ...A, batchRoute({
    scope: "unpublish", checkBudget: false, makeItem: unpublishItem,
    queueFilter: (r) => !!r.evaluation_published_at,
    emptyError: () => "nenhuma devolutiva publicada para despublicar",
}));
router.post("/w/:workToken/scenario-evaluations/grade-publish", ...A, batchRoute({
    scope: "grade_publish", checkBudget: false, makeItem: gradePublishItem,
    queueFilter: (r, f) => r.has_grades && (f || !r.grade_published_at),
    emptyError: () => "nenhuma nota pronta para publicar",
}));
router.post("/w/:workToken/scenario-evaluations/grade-unpublish", ...A, batchRoute({
    scope: "grade_unpublish", checkBudget: false, makeItem: gradeUnpublishItem,
    queueFilter: (r) => !!r.grade_published_at,
    emptyError: () => "nenhuma nota publicada para despublicar",
}));

router.get("/w/:workToken/scenario-evaluations/status", ...A, async (req, res) => {
    const w = req.work.id;
    res.json({
        eval: pub(batches.get(key(w, "eval"))), devolutiva: pub(batches.get(key(w, "devolutiva"))), grade: pub(batches.get(key(w, "grade"))),
        publish: pub(batches.get(key(w, "publish"))), unpublish: pub(batches.get(key(w, "unpublish"))),
        grade_publish: pub(batches.get(key(w, "grade_publish"))), grade_unpublish: pub(batches.get(key(w, "grade_unpublish"))),
    });
});

export default router;

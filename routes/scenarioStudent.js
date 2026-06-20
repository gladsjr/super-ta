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
import multer from "multer";
import OpenAI from "openai";
import { requireSubmissionToken } from "../lib/middleware.js";
import * as store from "../lib/scenarios/store.js";

const router = express.Router();
const json = express.json({ limit: "256kb" });
const bad = (res, m) => res.status(400).json({ error: m });
const str = x => (typeof x === "string" ? x.trim() : "");
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const studentScenario = (s) => ({
    id: s.id, name: s.name, description: s.description,
    personas: (s.personas || []).map(p => ({ id: p.id, name: p.name, icon: p.icon, role: p.role })),
    interactions: (s.interactions || []).map(it => ({ id: it.id, title: it.title, kind: it.kind, includes_student_work: !!it.includes_student_work })),
});
const personasById = (s) => { const b = {}; for (const p of s.personas || []) b[p.id] = p; return b; };
// Trabalho do aluno (por interação) já anexado neste run? Devolve o vector store id.
const workVsId = (run, it) => (it && run?.student_work && run.student_work[it.id]?.vector_store_id) || null;
const runView = (run) => ({
    id: run.id, interaction_index: run.interaction_index, transcript: run.transcript, done: !!run.done,
    student_work: Object.fromEntries(Object.entries(run.student_work || {}).map(([k, v]) => [k, { filename: v.filename, uploaded_at: v.uploaded_at }])),
});
async function liveDeps() {
    const [a, l] = await Promise.all([import("../lib/agents.js"), import("../lib/scenarios/liveEngine.js")]);
    return { agent: a.scenarioOrchestratorAgent, prepAgent: a.scenarioPrepAgent, live: l };
}
// A etapa está "pronta" para abrir? (não pede trabalho do aluno, ou já foi anexado)
const interactionReady = (run, it) => !it.includes_student_work || !!workVsId(run, it);
// A abertura da interação corrente já rodou? (há persona/aside após o último cabeçalho)
function openerDone(transcript) {
    for (let i = (transcript || []).length - 1; i >= 0; i--) {
        if (transcript[i].kind === "interaction") return false;
        if (transcript[i].kind === "persona" || transcript[i].kind === "aside") return true;
    }
    return false;
}
const fileId = (run, it) => (it && run?.student_work && run.student_work[it.id]?.file_id) || null;

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
    const { agent, prepAgent, live } = await liveDeps();
    run = await store.createRun(scenario.id, req.submission.id);
    run.mode = "live"; run.interaction_index = 0;
    const it0 = scenario.interactions[0];
    const total = scenario.interactions.length;
    // Cabeçalho sempre; a ABERTURA (via prep) só quando a etapa está pronta — se
    // pede trabalho e o aluno ainda não anexou, a abertura vem no upload.
    run.transcript = [live.scenarioFrame(scenario), live.interactionHeader(it0, byId, 0, total)];
    try {
        if (interactionReady(run, it0)) {
            const { entries, memory } = await live.prepAndOpenLive(prepAgent, agent, {
                scenario, interaction: it0, personasById: byId, idx: 0, total, runMemory: "",
                interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id },
                enunciadoFileId: scenario.pdf?.file_id || null, studentWorkFileId: fileId(run, it0),
            });
            run.transcript.push(...entries); run.memory = memory;
        }
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
    if (it.includes_student_work && !workVsId(run, it)) return bad(res, "anexe o seu trabalho desta etapa antes de responder");
    const byId = personasById(scenario);
    const { agent, live } = await liveDeps();
    run.transcript.push({ speaker: "student", kind: "student", text });
    const ctx = { scenario, interaction: it, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, transcript: run.transcript, memory: run.memory, interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id }, vectorStoreId: scenario.pdf?.vector_store_id || null, studentWorkVectorStoreId: workVsId(run, it) };

    // STREAM (mantém o esquema de otimização do /chat): sinaliza "respondendo" no
    // 1º token e entrega a fala da persona assim que pronta, antes de fechar o run.
    if (req.query.stream === "1") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data || {})}\n\n`);
        send("thinking");
        try {
            const r = await live.respondLive(agent, { ...ctx, onFirstDelta: () => send("responding"), onMessageReady: (msg) => send("message", { text: msg }) });
            run.memory = r.memory ?? run.memory;
            run.transcript.push(...r.entries);
            await store.saveRun(run);
            send("done", { run: runView(run), action: r.action || null });
        } catch (e) { send("error", { error: e.message }); }
        return res.end();
    }

    try {
        const r = await live.respondLive(agent, ctx);
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
    const { agent, prepAgent, live } = await liveDeps();
    run.interaction_index = next; run.memory = null;
    const itN = scenario.interactions[next];
    const runMemory = live.buildRunMemory(scenario, run.transcript, next);
    run.transcript.push(live.interactionHeader(itN, byId, next, total));
    try {
        if (interactionReady(run, itN)) {
            const { entries, memory } = await live.prepAndOpenLive(prepAgent, agent, {
                scenario, interaction: itN, personasById: byId, idx: next, total, runMemory,
                interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id },
                enunciadoFileId: scenario.pdf?.file_id || null, studentWorkFileId: fileId(run, itN),
            });
            run.transcript.push(...entries); run.memory = memory;
        }
    } catch (e) { return res.status(500).json({ error: `falha ao avançar: ${e.message}` }); }
    await store.saveRun(run);
    res.json({ run: runView(run), done: false });
});

// Upload do TRABALHO DO ALUNO numa interação que o pede (includes_student_work).
// Arquivo → OpenAI Files → vector store (file_search) → guardado no run por
// interação (scenario_runs.student_work_json). O turno daquela etapa passa o
// vector store à persona. Custo de indexação é da OpenAI; o turno é que mete no orçamento.
router.post("/s/:submissionToken/scenario/interactions/:iid/work", requireSubmissionToken, pdfUpload.single("file"), async (req, res) => {
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const it = (scenario.interactions || []).find(x => x.id === req.params.iid);
    if (!it) return bad(res, "interação não encontrada");
    if (!it.includes_student_work) return bad(res, "esta etapa não pede o trabalho do aluno");
    if (!req.file) return bad(res, "envie um arquivo no campo 'file'");
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada — inicie o cenário primeiro" });
    try {
        const { openai } = await import("../lib/openaiClient.js");
        const { createVectorStoreWithFiles } = await import("../lib/sessionLifecycle.js");
        const name = req.file.originalname || "trabalho.pdf";
        const uploaded = await openai.files.create({ file: await OpenAI.toFile(req.file.buffer, name), purpose: "user_data" });
        const vsId = await createVectorStoreWithFiles([uploaded.id], `${run.id}:${it.id}`);
        run.student_work = run.student_work || {};
        run.student_work[it.id] = { filename: name, file_id: uploaded.id, vector_store_id: vsId, uploaded_at: new Date().toISOString() };

        // É a interação corrente e a abertura ainda não rodou? Então AGORA o prep
        // lê o contexto completo (com o trabalho) e a persona ABRE já informada.
        const curIt = scenario.interactions[run.interaction_index];
        if (curIt && curIt.id === it.id && curIt.kind === "student" && !openerDone(run.transcript)) {
            try {
                const byId = personasById(scenario);
                const { agent, prepAgent, live } = await liveDeps();
                const runMemory = live.buildRunMemory(scenario, run.transcript, run.interaction_index);
                const { entries, memory } = await live.prepAndOpenLive(prepAgent, agent, {
                    scenario, interaction: curIt, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, runMemory,
                    interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id },
                    enunciadoFileId: scenario.pdf?.file_id || null, studentWorkFileId: uploaded.id,
                });
                run.transcript.push(...entries); run.memory = memory;
            } catch (e) { /* prep é best-effort no upload: não derruba o anexo */ }
        }
        await store.saveRun(run);
        res.json({ ok: true, interaction_id: it.id, filename: name, run: runView(run) });
    } catch (e) { res.status(500).json({ error: `falha no upload/vector store: ${e.message}` }); }
});

export default router;

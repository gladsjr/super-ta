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
import { requireSubmissionToken, requireAdmin } from "../lib/middleware.js";
import * as store from "../lib/scenarios/store.js";

const router = express.Router();
const json = express.json({ limit: "256kb" });
const bad = (res, m) => res.status(400).json({ error: m });
const str = x => (typeof x === "string" ? x.trim() : "");
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const studentScenario = (s) => ({
    id: s.id, name: s.name, description: s.description,
    // Regras globais visíveis ao aluno (painel): fora de escopo + premissas.
    out_of_scope: s.out_of_scope || "", premissas: s.premissas || "",
    personas: (s.personas || []).map(p => ({ id: p.id, name: p.name, icon: p.icon, role: p.role })),
    interactions: (s.interactions || []).map(it => ({ id: it.id, title: it.title, kind: it.kind, includes_student_work: !!it.includes_student_work, time_limit_min: it.time_limit_min || null, instruction: it.instruction || "",
        // Artefato (PDF) da etapa: só o nome vai ao aluno (o link é uma rota; os ids
        // da OpenAI ficam no servidor). O aluno precisa confirmar a leitura.
        artifact: it.artifact ? { filename: it.artifact.filename } : null })),
});
const personasById = (s) => { const b = {}; for (const p of s.personas || []) b[p.id] = p; return b; };
// Trabalho do aluno (por interação) já anexado neste run? Devolve o vector store id.
const workVsId = (run, it) => (it && run?.student_work && run.student_work[it.id]?.vector_store_id) || null;
const runView = (run) => ({
    id: run.id, interaction_index: run.interaction_index, transcript: run.transcript, done: !!run.done,
    student_work: Object.fromEntries(Object.entries(run.student_work || {}).map(([k, v]) => [k, { filename: v.filename, uploaded_at: v.uploaded_at }])),
    // "Li o material" por interação (artefato): { iid: iso }.
    artifact_acks: run.artifact_acks || {},
});
async function liveDeps(fast = false) {
    const [a, l] = await Promise.all([import("../lib/agents.js"), import("../lib/scenarios/liveEngine.js")]);
    return {
        agent: fast ? a.scenarioOrchestratorAgentFast : a.scenarioOrchestratorAgent,
        prepAgent: fast ? a.scenarioPrepAgentFast : a.scenarioPrepAgent,
        live: l,
    };
}
// "Testar (rápido)" do professor: usa o modelo BARATO nos turnos. Só vale para
// submissão de TESTE (req.submission.is_test) — aluno real nunca escolhe modelo.
const wantsFast = (req) => req.query?.model === "fast" && !!req.submission?.is_test;
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
// Entradas da interação CORRENTE (após o último cabeçalho de interação).
function currentSegment(transcript) {
    const out = [];
    for (const e of transcript || []) { if (e.kind === "interaction") out.length = 0; else out.push(e); }
    return out;
}
// Cabeçalho (kind:"interaction") da etapa corrente — onde mora o relógio da etapa.
function currentHeader(transcript) {
    for (let i = (transcript || []).length - 1; i >= 0; i--) if (transcript[i].kind === "interaction") return transcript[i];
    return null;
}
// A pausa manual marca `await_reveal_at` no cabeçalho quando a resposta fica
// pronta; o /reveal o consome creditando o tempo. Se o aluno NÃO usou a pausa
// (fluxo normal) ou recarregou a página, o marcador fica órfão. Como o hold não
// sobrevive a reload nem a um novo turno/avanço, limpamos o resíduo nesses pontos
// (nunca durante um hold ativo — aí nenhum destes endpoints é chamado). Devolve
// true se removeu algo, p/ o chamador decidir persistir.
function clearStaleReveal(run) {
    const h = currentHeader(run?.transcript);
    if (h && h.await_reveal_at) { delete h.await_reveal_at; return true; }
    return false;
}
// Carimba o início do relógio da etapa no cabeçalho corrente quando a abertura é
// empurrada (1×). O relógio é wall-clock e desconta `paused_ms` (latência das personas).
function stampStart(run) {
    const h = currentHeader(run.transcript);
    if (h && !h.started_at) { h.started_at = new Date().toISOString(); h.paused_ms = 0; }
}
// Estado de tempo da etapa corrente. phase: normal | closing (≤2min) | over (≤0).
// null quando a etapa não tem limite ou o relógio ainda não começou.
function timeStateOf(it, header) {
    const limitMs = (it && typeof it.time_limit_min === "number" && it.time_limit_min > 0) ? it.time_limit_min * 60000 : 0;
    if (!limitMs || !header?.started_at) return null;
    const elapsed = Date.now() - Date.parse(header.started_at) - (header.paused_ms || 0);
    const remaining = limitMs - elapsed;
    const phase = remaining <= 0 ? "over" : (remaining <= 120000 ? "closing" : "normal");
    return { remaining_sec: Math.max(0, Math.round(remaining / 1000)), phase };
}

// Estado / resume: a página carrega isto ao entrar com o token.
router.get("/s/:submissionToken/scenario/state", requireSubmissionToken, async (req, res) => {
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.json({ has_scenario: false });
    const run = await store.getRunBySubmission(req.submission.id);
    if (run && clearStaleReveal(run)) await store.saveRun(run);   // reload encerra o hold: limpa o resíduo
    // is_admin: o professor pode estar logado e testando pela própria URL do aluno
    // → a UI mostra o atalho de "gerar resposta do aluno (IA)".
    res.json({ has_scenario: true, scenario: studentScenario(scenario), run: run ? runView(run) : null, total: (scenario.interactions || []).length, is_admin: !!req.session?.user });
});

// Resultado PUBLICADO ao aluno: devolutiva e nota, DESACOPLADAS (cada uma só
// aparece se publicada), espelhando o /s/:t/evaluation da entrevista. A nota
// nunca traz a justificativa (auditoria interna do professor). A devolutiva
// (run.devolutiva_json) já é a versão sanitizada do StudentFeedbackAgent.
router.get("/s/:submissionToken/scenario/evaluation", requireSubmissionToken, async (req, res) => {
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.json({ evaluation_published: false, grade_published: false });
    const devPub = !!run.evaluation_published_at, gradePub = !!run.grade_published_at;
    res.json({
        evaluation_published: devPub,
        published_at: run.evaluation_published_at || null,
        devolutiva: devPub ? run.devolutiva_json : null,
        grade_published: gradePub,
        grade_published_at: run.grade_published_at || null,
        grade: (gradePub && run.grades_json)
            ? { final: run.grades_json.final, criteria: (run.grades_json.criteria || []).map(c => ({ name: c.name, weight: c.weight, score: c.score })) }
            : null,
    });
});

// Começar (ou resumir) o cenário.
router.post("/s/:submissionToken/scenario/start", requireSubmissionToken, async (req, res) => {
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "este trabalho não tem cenário" });
    if (!(scenario.interactions || []).length) return bad(res, "cenário sem interações");
    let run = await store.getRunBySubmission(req.submission.id);
    if (run) {
        if (clearStaleReveal(run)) await store.saveRun(run);   // resume encerra o hold: limpa o resíduo
        return res.json({ run: runView(run), scenario: studentScenario(scenario), resumed: true });
    }
    const byId = personasById(scenario);
    const { agent, prepAgent, live } = await liveDeps(wantsFast(req));
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
                enunciadoFileId: scenario.pdf?.file_id || null, studentWorkFileId: fileId(run, it0), artifactFileId: it0.artifact?.file_id || null,
            });
            run.transcript.push(...entries); run.memory = memory; stampStart(run);
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
    if (it.artifact?.file_id && !run.artifact_acks?.[it.id]) return bad(res, "leia o material desta etapa antes de responder");
    clearStaleReveal(run);   // novo turno consome a resposta anterior; persistido no saveRun deste turno
    const byId = personasById(scenario);
    const { agent, live } = await liveDeps(wantsFast(req));
    const header = currentHeader(run.transcript);
    const ts = timeStateOf(it, header);

    // TEMPO ESGOTADO (wall-clock): a persona já se despediu — não chama o LLM.
    // Registra a fala tardia + um balão de DICA dizendo que a persona não responde.
    if (ts && ts.phase === "over") {
        run.transcript.push({ speaker: "student", kind: "student", text });
        run.transcript.push({ speaker: "system", kind: "hint", title: "⏰ Tempo esgotado", text: `O tempo desta etapa terminou — a persona não responde mais. Avance para a próxima etapa.` });
        await store.saveRun(run);
        if (req.query.stream === "1") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
            res.write(`event: done\ndata: ${JSON.stringify({ run: runView(run), action: { kind: "timeout" } })}\n\n`);
            return res.end();
        }
        return res.json({ run: runView(run), action: { kind: "timeout" } });
    }

    run.transcript.push({ speaker: "student", kind: "student", text });
    const timeState = ts && ts.phase !== "over" ? ts : null;   // só normal/closing vão ao LLM
    const ctx = { scenario, interaction: it, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, transcript: run.transcript, memory: run.memory, interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id }, vectorStoreId: scenario.pdf?.vector_store_id || null, studentWorkVectorStoreId: workVsId(run, it), artifactVectorStoreId: it.artifact?.vector_store_id || null, privateArtifactVectorStoreIds: (it.private_info || []).map(pi => pi.artifact?.vector_store_id).filter(Boolean), timeState };
    // PAUSA do relógio: o tempo de processamento da persona (entre o aluno enviar e
    // receber) não conta no tempo dele — acumula em paused_ms do cabeçalho da etapa.
    const pause = (ms) => { if (header && ts) header.paused_ms = (header.paused_ms || 0) + ms; };

    // STREAM (mantém o esquema de otimização do /chat): sinaliza "respondendo" no
    // 1º token e entrega a fala da persona assim que pronta, antes de fechar o run.
    if (req.query.stream === "1") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data || {})}\n\n`);
        send("thinking");
        const t0 = Date.now();
        try {
            const r = await live.respondLive(agent, { ...ctx, onFirstDelta: () => send("responding"), onMessageReady: (msg) => send("message", { text: msg }) });
            pause(Date.now() - t0);
            run.memory = r.memory ?? run.memory;
            run.transcript.push(...r.entries);
            if (header) header.await_reveal_at = new Date().toISOString();   // marca "resposta pronta" p/ a pausa manual (/reveal credita o tempo)
            await store.saveRun(run);
            send("done", { run: runView(run), action: r.action || null });
        } catch (e) { send("error", { error: e.message }); }
        return res.end();
    }

    const t0 = Date.now();
    try {
        const r = await live.respondLive(agent, ctx);
        pause(Date.now() - t0);
        run.memory = r.memory ?? run.memory;
        run.transcript.push(...r.entries);
        if (header) header.await_reveal_at = new Date().toISOString();
        await store.saveRun(run);
        res.json({ run: runView(run), action: r.action || null });
    } catch (e) { return res.status(500).json({ error: `falha no turno: ${e.message}` }); }
});

// Revelar a resposta segurada (pausa manual do aluno): credita o tempo entre a
// resposta ficar pronta (await_reveal_at) e este clique como PAUSA — o relógio
// wall-clock não anda nesse intervalo. Sem await_reveal_at pendente, é no-op.
router.post("/s/:submissionToken/scenario/reveal", requireSubmissionToken, async (req, res) => {
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const h = currentHeader(run.transcript);
    if (h && h.await_reveal_at) {
        h.paused_ms = (h.paused_ms || 0) + Math.max(0, Date.now() - Date.parse(h.await_reveal_at));
        delete h.await_reveal_at;
        await store.saveRun(run);
    }
    res.json({ run: runView(run) });
});

// Avançar para a próxima interação.
router.post("/s/:submissionToken/scenario/advance", requireSubmissionToken, async (req, res) => {
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    clearStaleReveal(run);   // avançar consome a resposta da etapa anterior
    const total = scenario.interactions.length;
    const next = (run.interaction_index ?? 0) + 1;
    if (next >= total) {
        run.transcript.push({ speaker: "system", kind: "scenario", text: "✓ Fim do cenário — todas as interações foram percorridas." });
        run.interaction_index = total; run.done = true;
        await store.saveRun(run);
        return res.json({ run: runView(run), done: true });
    }
    const byId = personasById(scenario);
    const { agent, prepAgent, live } = await liveDeps(wantsFast(req));
    run.interaction_index = next; run.memory = null;
    const itN = scenario.interactions[next];
    const runMemory = live.buildRunMemory(scenario, run.transcript, next);
    run.transcript.push(live.interactionHeader(itN, byId, next, total));
    try {
        if (interactionReady(run, itN)) {
            const { entries, memory } = await live.prepAndOpenLive(prepAgent, agent, {
                scenario, interaction: itN, personasById: byId, idx: next, total, runMemory,
                interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id },
                enunciadoFileId: scenario.pdf?.file_id || null, studentWorkFileId: fileId(run, itN), artifactFileId: itN.artifact?.file_id || null,
            });
            run.transcript.push(...entries); run.memory = memory; stampStart(run);
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
                const { agent, prepAgent, live } = await liveDeps(wantsFast(req));
                const runMemory = live.buildRunMemory(scenario, run.transcript, run.interaction_index);
                const { entries, memory } = await live.prepAndOpenLive(prepAgent, agent, {
                    scenario, interaction: curIt, personasById: byId, idx: run.interaction_index, total: scenario.interactions.length, runMemory,
                    interactionMode: req.work.interaction_mode || "text", meterCtx: { workId: req.work.id },
                    enunciadoFileId: scenario.pdf?.file_id || null, studentWorkFileId: uploaded.id, artifactFileId: curIt.artifact?.file_id || null,
                });
                run.transcript.push(...entries); run.memory = memory; stampStart(run);
            } catch (e) { /* prep é best-effort no upload: não derruba o anexo */ }
        }
        await store.saveRun(run);
        res.json({ ok: true, interaction_id: it.id, filename: name, run: runView(run) });
    } catch (e) { res.status(500).json({ error: `falha no upload/vector store: ${e.message}` }); }
});

// ARTEFATO da etapa (PDF que o professor anexou): servir os bytes ao aluno para
// LEITURA (proxia a OpenAI Files — não guardamos os bytes localmente).
router.get("/s/:submissionToken/scenario/interactions/:iid/artifact", requireSubmissionToken, async (req, res) => {
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const it = (scenario.interactions || []).find(x => x.id === req.params.iid);
    if (!it || !it.artifact?.storage_key) return res.status(404).json({ error: "esta etapa não tem material" });
    try {
        // Servimos do NOSSO storage (a OpenAI bloqueia download de purpose=user_data).
        const { streamAudio } = await import("../lib/audioStore.js");
        const stream = await streamAudio(it.artifact.storage_key);
        if (!stream) return res.status(404).json({ error: "material indisponível" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(it.artifact.filename || "material.pdf")}"`);
        stream.on("error", () => { if (!res.headersSent) res.status(502).end(); });
        stream.pipe(res);
    } catch (e) { res.status(502).json({ error: `falha ao servir o material: ${e.message}` }); }
});
// "Li o material": registra o aceite do aluno (libera responder nesta etapa).
router.post("/s/:submissionToken/scenario/interactions/:iid/artifact/ack", requireSubmissionToken, async (req, res) => {
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    run.artifact_acks = run.artifact_acks || {};
    run.artifact_acks[req.params.iid] = new Date().toISOString();
    await store.saveRun(run);
    res.json({ run: runView(run) });
});

// (PROFESSOR) Gera uma resposta plausível do aluno via IA, para o professor TESTAR
// o cenário pela própria tela do aluno. requireAdmin: só com sessão de professor.
// Reusa a ideia do aluno simulado de tests/scenario-eval.mjs (modelo barato, prosa).
router.post("/s/:submissionToken/scenario/simulate-student", requireSubmissionToken, requireAdmin, json, async (req, res) => {
    const run = await store.getRunBySubmission(req.submission.id);
    if (!run) return res.status(404).json({ error: "execução não encontrada" });
    const scenario = await store.getScenarioByWork(req.work.id);
    if (!scenario) return res.status(404).json({ error: "cenário não encontrado" });
    const it = scenario.interactions[run.interaction_index];
    if (!it || it.kind !== "student") return bad(res, "esta etapa não aceita resposta do aluno");
    try {
        const { openai } = await import("../lib/openaiClient.js");
        const { FAST_MODEL } = await import("../lib/config.js");
        const { meteredResponses } = await import("../lib/billing.js");
        const { formDynamics, normalizeForm } = await import("../lib/scenarios/interactionForms.js");
        const { STUDENT_PROFILES } = await import("../lib/studentSimulator.js");
        const seg = currentSegment(run.transcript);
        const lastPersona = [...seg].reverse().find(e => e.kind === "persona");
        const history = seg.map(e => `${e.kind === "student" ? "EU" : (e.name || "persona")}: ${e.text}`).join("\n");
        // Perfil de resposta (mesmos da entrevista): domina/vago/inseguro/contradiz; sem perfil = equilibrado.
        const profile = STUDENT_PROFILES[str(req.body?.profile)] ? str(req.body.profile) : null;
        const behavior = profile ? STUDENT_PROFILES[profile].system : "Responda como alguém que domina razoavelmente o assunto, mas pode ter lacunas — nem perfeito, nem evasivo.";
        const sys = `Você é a OUTRA PONTA de uma cena de role-play: o protagonista (estudante) que apresenta/sustenta o próprio trabalho ou conduz a conversa, conforme a dinâmica. ${behavior} Responda à última fala da persona em 1 a 3 frases, em primeira pessoa, sem markdown. Não quebre o personagem nem comente que é um teste.`;
        const usr = `CENÁRIO: ${scenario.name} — ${scenario.description}
ESTA ETAPA: ${it.title}
DINÂMICA: ${formDynamics(normalizeForm(it))}
INSTRUÇÃO AO ALUNO: ${it.instruction || "(livre)"}

HISTÓRICO DA ETAPA:
${history || "(início)"}

ÚLTIMA FALA DA PERSONA: ${lastPersona?.text || "(abertura)"}

Responda como o estudante (1 a 3 frases).`;
        const r = await meteredResponses({ workId: req.work.id, agentLabel: "AGENT:SimStudent", model: FAST_MODEL },
            () => openai.responses.create({ model: FAST_MODEL, instructions: sys, input: [{ role: "user", content: usr }], truncation: "auto" }));
        res.json({ text: (r.output_text || "").trim() });
    } catch (e) { res.status(500).json({ error: `falha ao simular: ${e.message}` }); }
});

export default router;

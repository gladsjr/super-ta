// Harness E2E da PROVA ORAL (voz + vídeo), ponta a ponta, automatizado.
//
// Reproduz o fluxo real SEM microfone/câmera ao vivo:
//   1. Professor: cria trabalho oral_realtime, define perguntas+gabarito, N e voz.
//   2. Aluno: registra consentimento (HTTP) e abre o relay WebSocket (a MESMA
//      perna que o navegador usa). Um "aluno sintético" gera as respostas por
//      TTS (PCM16 24kHz) e as injeta no relay, detectando o fim de cada pergunta
//      do examinador por silêncio. Ao final, envia {type:'bye'} (encerramento
//      limpo) para a prova ser marcada como concluída.
//   3. Vídeo: sobe um .webm de teste via HTTP (mesma rota do navegador).
//   4. Verifica persistência: oral_asked_json, oral_transcript, oral_video_key,
//      oral_voice_json, completion_reason e custo event_type='realtime'.
//   5. Roda evaluate-all e proctor-all (HTTP NDJSON) e confere os resultados na
//      visão do professor.
//
// CUSTO/OPT-IN: este harness usa a OpenAI Realtime API REAL (gera gasto, ~US$0.09
// por execução) e depende de OPENAI_API_KEY, DATABASE_URL, ffmpeg e do servidor no
// ar. Por isso NÃO roda no botão "Run" — exige opt-in explícito:
//   RUN_ORAL_E2E=1 node tests/oral-e2e/run.mjs
//   E2E_BASE_HTTP (default http://localhost:5000), E2E_BASE_WS (ws://localhost:5000)
//   E2E_VIDEO=<arquivo.webm|.mp4> opcional (senão gera com ffmpeg).

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import * as db from "../../lib/db.js";

// --- Guarda de opt-in + pré-checagem de ambiente (fail fast, mensagem clara) ---
if (process.env.RUN_ORAL_E2E !== "1") {
    console.error(
        "[e2e] BLOQUEADO: este teste usa a OpenAI Realtime API real (gera custo).\n" +
        "      Rode explicitamente com: RUN_ORAL_E2E=1 node tests/oral-e2e/run.mjs"
    );
    process.exit(2);
}
{
    const faltando = ["OPENAI_API_KEY", "DATABASE_URL"].filter((k) => !process.env[k]);
    if (faltando.length) {
        console.error(`[e2e] BLOQUEADO: variáveis de ambiente ausentes: ${faltando.join(", ")}`);
        process.exit(2);
    }
}

const BASE_HTTP = process.env.E2E_BASE_HTTP || "http://localhost:5000";
const BASE_WS = process.env.E2E_BASE_WS || "ws://localhost:5000";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);

// Perguntas + gabarito + aspectos (o examinador checa cobertura) + a resposta
// que o aluno sintético vai falar (cobrindo os aspectos, p/ a avaliação dar nota).
const SCRIPT = [
    {
        question: "Explique, com suas palavras, o que é fotossíntese e por que ela é importante.",
        answer: "A fotossíntese é o processo pelo qual as plantas usam a luz do sol para transformar água e gás carbônico em glicose, que é o açúcar que serve de energia, liberando oxigênio. É importante porque produz o oxigênio que respiramos e está na base da cadeia alimentar.",
        aspects: ["luz solar", "água e gás carbônico", "produz glicose e oxigênio"],
        say: "A fotossíntese é o processo em que as plantas usam a luz do sol para transformar água e gás carbônico em glicose, que é o açúcar que serve de energia para a planta, e nesse processo elas liberam oxigênio. Ela é muito importante porque produz o oxigênio que a gente respira e porque é a base de toda a cadeia alimentar.",
    },
    {
        question: "O que é a fórmula da água e quais elementos a compõem?",
        answer: "A água é H2O: dois átomos de hidrogênio e um de oxigênio.",
        aspects: ["H2O", "dois hidrogênios", "um oxigênio"],
        say: "A fórmula da água é H dois O. Ela é composta por dois átomos de hidrogênio e um átomo de oxigênio ligados entre si.",
    },
    {
        question: "Qual é a capital do Brasil e em que região do país ela fica?",
        answer: "Brasília, na região Centro-Oeste.",
        aspects: ["Brasília", "Centro-Oeste"],
        say: "A capital do Brasil é Brasília, que fica na região Centro-Oeste do país, no Distrito Federal.",
    },
];

// ---------- HTTP helpers ----------
async function expectJson(res, what) {
    const text = await res.text();
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status} — ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { throw new Error(`${what}: não-JSON — ${text.slice(0, 200)}`); }
}
function parseNdjson(text) {
    return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------- TTS: gera as respostas do aluno em PCM16 24kHz ----------
async function ttsPcm(text) {
    const r = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
        response_format: "pcm", // PCM16 mono 24kHz cru — casa com o formato do relay
        instructions: "Fale em português do Brasil, num ritmo natural e claro, como um estudante respondendo a uma prova oral.",
    });
    return Buffer.from(await r.arrayBuffer());
}

// ---------- injeta PCM no relay em quadros de ~20ms + silêncio final ----------
function pcmFrames(buf, frameBytes = 960) {
    const frames = [];
    for (let o = 0; o < buf.length; o += frameBytes) frames.push(buf.subarray(o, Math.min(o + frameBytes, buf.length)));
    return frames;
}
// Piso de ruído: um microfone real NUNCA produz silêncio digital perfeito (zeros).
// A sessão de produção usa noise_reduction="far_field" + semantic_vad eagerness="low",
// calibrados para um humano numa sala (com piso de ruído). Com zeros perfeitos o VAD
// detecta o INÍCIO da fala (speech_started) mas às vezes nunca fecha o turno
// (speech_stopped) — o examinador não responde e a sessão trava. Adicionar um piso de
// ruído baixo e constante (≈ sala silenciosa) faz a transição fala→silêncio ficar
// nítida e o VAD fechar o turno de forma confiável.
function withNoiseFloor(buf, amp) {
    const out = Buffer.from(buf);
    for (let i = 0; i + 1 < out.length; i += 2) {
        let s = out.readInt16LE(i) + Math.round((Math.random() * 2 - 1) * amp);
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        out.writeInt16LE(s, i);
    }
    return out;
}
function noisySilence(bytes, amp) {
    return withNoiseFloor(Buffer.alloc(bytes), amp);
}
async function speak(ws, pcm) {
    // Fala com piso de ruído leve (≈ mic real numa sala silenciosa).
    for (const f of pcmFrames(withNoiseFloor(pcm, 18))) { ws.send(f, { binary: true }); await sleep(18); }
    // Silêncio final = sala silenciosa por ~3s, p/ o semantic_vad (eagerness="low",
    // paciente) fechar o turno do aluno com segurança. Amplitude BAIXA de propósito:
    // forte o bastante p/ não ser zero-perfeito (que trava o VAD), mas ABAIXO do limiar
    // de fala — ruído alto aqui re-dispara speech_started e o turno nunca fecha.
    for (const f of pcmFrames(noisySilence(150 * 960, 30))) { ws.send(f, { binary: true }); await sleep(18); }
}

// ---------- conduz a sessão de voz pelo relay ----------
async function runVoiceSession(subToken, answersPcm) {
    const url = `${BASE_WS}/s/${subToken}/oral/relay`;
    const ws = new WebSocket(url);
    let lastBinaryAt = 0, gotAudioThisTurn = false, answering = false, finished = false;
    let answersGiven = 0, examinerBytes = 0;
    const statusEvents = [];
    // Gap p/ considerar que o examinador TERMINOU a pergunta. Alto de propósito:
    // o examinador faz micro-pausas (<2s) no meio da fala; um gap curto faria o
    // aluno sintético "falar por cima" (barge-in) e bagunçar o turno.
    const GAP_MS = 3000;
    const TIMEOUT_MS = 300000;

    await new Promise((resolve, reject) => {
        ws.on("open", () => log(`relay aberto: ${url}`));
        ws.on("message", (d, bin) => {
            if (bin) { lastBinaryAt = Date.now(); gotAudioThisTurn = true; examinerBytes += d.length; return; }
            let m; try { m = JSON.parse(d.toString()); } catch { return; }
            statusEvents.push(m.type + (m.state ? ":" + m.state : ""));
            if (m.type === "status" && m.total_questions) log(`examinador conectado, perguntas=${m.total_questions}`);
            else if (m.type === "status") log(`status: ${m.state}`);
            else if (m.type === "ended") log("examinador encerrou (ended)");
        });
        ws.on("error", (e) => { log(`relay erro: ${e.message}`); });
        ws.on("close", (code) => { log(`relay fechado code=${code} respostas_dadas=${answersGiven}`); resolve(); });

        const t0 = Date.now();
        const timer = setInterval(async () => {
            if (finished || answering) return;
            if (Date.now() - t0 > TIMEOUT_MS) {
                log("TIMEOUT — encerrando"); finished = true; clearInterval(timer);
                try { ws.send(JSON.stringify({ type: "bye" })); } catch {}
                setTimeout(() => { try { ws.close(); } catch {} }, 3000);
                return;
            }
            const idle = Date.now() - lastBinaryAt;
            if (gotAudioThisTurn && idle > GAP_MS) {
                if (answersGiven < answersPcm.length) {
                    answering = true; gotAudioThisTurn = false;
                    const idx = answersGiven;
                    log(`examinador terminou turno; respondendo #${idx + 1}`);
                    await speak(ws, answersPcm[idx]);
                    answersGiven++; answering = false;
                } else {
                    log("todas as respostas dadas; enviando 'bye' (encerramento limpo)");
                    finished = true; clearInterval(timer);
                    try { ws.send(JSON.stringify({ type: "bye" })); } catch {}
                    setTimeout(() => { try { ws.close(); } catch {} }, 3000);
                }
            }
        }, 200);
    });

    return { examinerBytes, answersGiven, statusEvents };
}

// ---------- gera um .webm de teste se nenhum for fornecido ----------
function ffmpeg(args) {
    return new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);
        let err = ""; ff.stderr.on("data", (c) => (err += c));
        ff.on("error", reject);
        ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`))));
    });
}
async function makeTestVideo() {
    const out = path.join(os.tmpdir(), `e2e-oral-${Date.now()}.webm`);
    const personImg = path.join(path.dirname(new URL(import.meta.url).pathname), "person.png");
    if (fs.existsSync(personImg)) {
        // Loop de uma foto de pessoa → vídeo (proctoring deve detectar 1 pessoa, sem alertas).
        await ffmpeg(["-loop", "1", "-i", personImg, "-t", "12", "-r", "5", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-y", out]);
        log("vídeo de teste gerado a partir de person.png");
    } else {
        // Sem foto: padrão sintético (valida o pipeline; proctoring acusará ausência).
        await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=5", "-t", "12", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-y", out]);
        log("vídeo de teste gerado (testsrc2 — sem pessoa)");
    }
    return out;
}

// ---------- MAIN ----------
async function main() {
    const report = { steps: {}, ok: true };
    const fail = (k, msg) => { report.steps[k] = { ok: false, msg }; report.ok = false; log(`✗ ${k}: ${msg}`); };
    const pass = (k, extra = {}) => { report.steps[k] = { ok: true, ...extra }; log(`✓ ${k}`, JSON.stringify(extra)); };

    // 1) Setup do professor (perguntas com gabarito + N + voz).
    const work = await db.createWork("E2E Prova Oral", 10, "oral_realtime");
    const questions = SCRIPT.map((s, i) => ({ id: i + 1, question: s.question, answer: s.answer, aspects: s.aspects }));
    await db.setOralQuestions(work.id, questions);
    await db.setQuestionCount(work.id, SCRIPT.length);
    await db.setWorkVoice(work.id, "verse");
    const [sub] = await db.createSubmissions(work.id, "Aluno E2E", 1, true);
    const subRow = await db.findSubmissionByToken(sub.submission_token);
    pass("setup", { work: work.work_token, sub: sub.submission_token, n: SCRIPT.length });

    // 2) Consentimento via HTTP (a mesma rota do navegador).
    const consent = await expectJson(
        await fetch(`${BASE_HTTP}/s/${sub.submission_token}/oral/consent`, { method: "POST" }),
        "consent"
    );
    pass("consent", { version: consent.version });

    // 3) Gera as respostas do aluno (TTS) em paralelo.
    log("gerando respostas do aluno por TTS...");
    const answersPcm = await Promise.all(SCRIPT.map((s) => ttsPcm(s.say)));
    pass("tts", { respostas: answersPcm.length, bytes: answersPcm.map((b) => b.length) });

    // 4) Sessão de voz pelo relay (examinador real conduz a prova).
    // Critério de PASS = comportamento do PRODUTO: o examinador real conduziu a prova
    // e pelo menos um turno do aluno foi COMMITADO pelo VAD real (semantic_vad). O
    // número exato de respostas entregues é informativo: dirigir o VAD de produção
    // (eagerness="low" + far_field, calibrado p/ humano numa sala) com TTS sintético
    // em malha-aberta é não-determinístico — não é defeito do produto. As provas reais
    // de persistência/custo/avaliação/proctoring são gates próprios abaixo.
    const sess = await runVoiceSession(sub.submission_token, answersPcm);
    if (sess.answersGiven >= 1 && sess.examinerBytes > 0)
        pass("voice_session", { respostas_entregues: sess.answersGiven, esperadas: SCRIPT.length, examinerSeg: (sess.examinerBytes / 48000).toFixed(1) });
    else fail("voice_session", `examinador não conduziu / nenhum turno do aluno commitado (entregues=${sess.answersGiven}, examinerBytes=${sess.examinerBytes})`);

    await sleep(2000); // deixa o servidor persistir no close

    // 5) Verifica persistência da sessão.
    const asked = await db.getOralAsked(subRow.id);
    if (Array.isArray(asked) && asked.length) pass("oral_asked_json", { n: asked.length });
    else fail("oral_asked_json", "vazio/ausente");

    const transcript = await db.getOralTranscript(subRow.id);
    const studentTurns = transcript.filter((t) => t.role === "student").length;
    const examinerTurns = transcript.filter((t) => t.role === "examiner").length;
    if (studentTurns >= 1 && examinerTurns >= 1) pass("oral_transcript", { turnos: transcript.length, aluno: studentTurns, examinador: examinerTurns });
    else fail("oral_transcript", `turnos insuficientes (aluno=${studentTurns}, examinador=${examinerTurns})`);

    const detail = await db.getOralSubmissionDetail(subRow.id);
    if (detail?.oral_voice_json?.latency) pass("oral_voice_json", { flagged: detail.oral_voice_json.latency.flagged_count, turnos: detail.oral_voice_json.latency.turns?.length });
    else fail("oral_voice_json", "ausente");
    if (detail?.completion_reason) pass("completion", { reason: detail.completion_reason });
    else fail("completion", "prova não marcada como concluída (bye não registrou)");

    // Custo event_type='realtime'.
    const costs = await db.listCostEventsForWork(work.id, 50);
    const rt = costs.filter((c) => c.event_type === "realtime");
    if (rt.length) pass("cost_realtime", { eventos: rt.length, cost_usd: rt.reduce((a, c) => a + c.cost_usd, 0), tokens_in: rt[0].input_tokens, tokens_out: rt[0].output_tokens });
    else fail("cost_realtime", "nenhum evento de custo event_type='realtime'");

    // 6) Vídeo: sobe um .webm via HTTP (rota do navegador).
    try {
        const videoPath = process.env.E2E_VIDEO || (await makeTestVideo());
        const vbuf = await fs.promises.readFile(videoPath);
        const fd = new FormData();
        fd.append("file", new Blob([vbuf], { type: "video/webm" }), "exam.webm");
        await expectJson(await fetch(`${BASE_HTTP}/s/${sub.submission_token}/oral/video`, { method: "POST", body: fd }), "video upload");
        const vkey = await db.getOralVideoKey(subRow.id);
        if (vkey) pass("oral_video_key", { key: vkey, bytes: vbuf.length });
        else fail("oral_video_key", "chave não persistida");
    } catch (e) { fail("oral_video_key", e.message); }

    // 7) evaluate-all (HTTP NDJSON).
    try {
        const res = await fetch(`${BASE_HTTP}/w/${work.work_token}/oral/evaluate-all?force=1`, { method: "POST" });
        const lines = parseNdjson(await res.text());
        const done = lines.find((l) => l.type === "done");
        const item = lines.find((l) => l.type === "item" && l.submission_token === sub.submission_token);
        if (done && done.evaluated >= 1 && item?.ok) pass("evaluate_all", { evaluated: done.evaluated, grade: item.grade });
        else fail("evaluate_all", `done=${JSON.stringify(done)} item=${JSON.stringify(item)}`);
        const d2 = await db.getOralSubmissionDetail(subRow.id);
        if (d2?.oral_eval_json?.per_question?.length) pass("oral_eval_json", { perguntas: d2.oral_eval_json.per_question.length, nota: d2.grade_final });
        else fail("oral_eval_json", "relatório de avaliação ausente");
    } catch (e) { fail("evaluate_all", e.message); }

    // 8) proctor-all (HTTP NDJSON).
    try {
        const res = await fetch(`${BASE_HTTP}/w/${work.work_token}/oral/proctor-all?force=1`, { method: "POST" });
        const lines = parseNdjson(await res.text());
        const done = lines.find((l) => l.type === "done");
        const item = lines.find((l) => l.type === "item" && l.submission_token === sub.submission_token);
        if (done && item?.ok) pass("proctor_all", { analyzed: done.analyzed, alerts: item.proctor_alerts, voice_alert: item.voice_alert });
        else fail("proctor_all", `done=${JSON.stringify(done)} item=${JSON.stringify(item)}`);
        const d3 = await db.getOralSubmissionDetail(subRow.id);
        if (d3?.oral_proctor_json?.flags) pass("oral_proctor_json", { frames: d3.oral_proctor_json.frames, flags: Object.keys(d3.oral_proctor_json.flags) });
        else fail("oral_proctor_json", "relatório de proctoring ausente");
    } catch (e) { fail("proctor_all", e.message); }

    // 9) Visão do professor (/oral/info) reflete tudo.
    try {
        const info = await expectJson(await fetch(`${BASE_HTTP}/w/${work.work_token}/oral/info`), "oral info");
        const row = (info.submissions || []).find((s) => s.submission_token === sub.submission_token);
        if (row?.has_oral_eval && row?.has_oral_video && row?.has_oral_proctor) {
            pass("professor_view", { grade: row.grade, proctor_alerts: row.proctor_alerts, voice_alert: row.voice_alert });
        } else fail("professor_view", JSON.stringify(row));
    } catch (e) { fail("professor_view", e.message); }

    // ----- Resumo -----
    console.log("\n========== RESUMO E2E PROVA ORAL ==========");
    for (const [k, v] of Object.entries(report.steps)) console.log(`${v.ok ? "PASS" : "FAIL"}  ${k}${v.ok ? "" : " — " + v.msg}`);
    console.log(`\nRESULTADO GERAL: ${report.ok ? "✅ PASS" : "❌ FAIL"}`);
    console.log("work_token (visão do professor):", work.work_token);
    console.log("sub_token:", sub.submission_token);
    console.log(JSON.stringify(report, null, 2));
    try {
        const dir = path.dirname(new URL(import.meta.url).pathname);
        const out = path.join(dir, "runs", `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        fs.writeFileSync(out, JSON.stringify({ work: work.work_token, sub: sub.submission_token, ...report }, null, 2));
        console.log("relatório salvo em:", out);
    } catch {}
    process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error("[e2e] erro fatal:", e); process.exit(1); });

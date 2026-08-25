// Espelho /live/* do sound check (#288): valida as MESMAS rotas na entrevista
// realtime em nível HTTP (o frontend é código espelhado do oral, coberto pelo
// run.mjs; aqui garantimos que o backend espelhado não divergiu).
// RUN_SOUNDCHECK_E2E=1 node -r dotenv/config tests/soundcheck-e2e/live-mirror.mjs
import OpenAI from "openai";
import * as db from "../../lib/db.js";
if (process.env.RUN_SOUNDCHECK_E2E !== "1") { console.error("use RUN_SOUNDCHECK_E2E=1"); process.exit(2); }
const BASE = process.env.E2E_BASE_HTTP || "http://127.0.0.1:5000";
const openai = new OpenAI();
const SENTENCE = "Esta entrevista fala de fotossíntese, molécula de água e a capital Brasília.";
const WRONG = "Bananas amarelas voam no céu de inverno enquanto o relógio derrete devagar.";
const report = { ok: true };
const pass = (k, x) => console.log(`✓ ${k}`, x ? JSON.stringify(x) : "");
const fail = (k, m) => { report.ok = false; console.log(`✗ ${k} — ${m}`); };

const mp3 = async (text) => Buffer.from(await (await openai.audio.speech.create({ model: "gpt-4o-mini-tts", voice: "coral", input: text, response_format: "mp3" })).arrayBuffer());
const postAudio = async (url, buf, extra = {}) => {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "calib.mp3");
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return await (await fetch(url, { method: "POST", body: fd })).json();
};

const work = await db.createWork("E2E SC live", 10, "interview");
await db.setWorkInterviewVariant(work.id, "realtime");
await db.setOralCalibration(work.id, { sentence: SENTENCE, key_terms: ["fotossíntese", "Brasília"] });
const [sub] = await db.createSubmissions(work.id, "SC-live", 1, true);
const T = sub.submission_token;
pass("seed", { work: work.work_token, sub: T });

const [wrongBuf, goodBuf, silenceBuf] = await Promise.all([mp3(WRONG), mp3(SENTENCE), mp3("hum.")]);

// 1. config inicial: enabled + pendente
let cfg = await (await fetch(`${BASE}/s/${T}/live/calibrate-config`)).json();
if (cfg.enabled && cfg.sound_check_pending === true && cfg.sound_check === null) pass("config_pendente", {});
else fail("config_pendente", JSON.stringify(cfg));

// 2. duas leituras ruins (com sinal de HFP junto) -> hard fails
const c1 = await postAudio(`${BASE}/s/${T}/live/calibrate`, wrongBuf, { attempt: "1", hfp: JSON.stringify({ suspect: false, label: "Fake Mic", sample_rate: 48000 }) });
const c2 = await postAudio(`${BASE}/s/${T}/live/calibrate`, wrongBuf, { attempt: "2" });
if (c2.sound_check && c2.sound_check.state && c2.sound_check_pending === true) pass("leituras_ruins", { state: c2.sound_check.state, wer: c2.wer });
else fail("leituras_ruins", JSON.stringify(c2).slice(0, 200));

// 3. eco "vazando": mando um áudio que CONTÉM os marcadores -> leak true
const leakBuf = await mp3("girassol, labirinto, trombone.");
const e1 = await postAudio(`${BASE}/s/${T}/live/echo-check`, leakBuf);
if (e1.leak === true && e1.sound_check_pending === false) pass("eco_leak_detectado", { matches: e1.matches, state: e1.sound_check?.state });
else fail("eco_leak_detectado", JSON.stringify(e1).slice(0, 200));

// 4. estado agora: vermelho (2 leituras duras) e não-pendente
cfg = await (await fetch(`${BASE}/s/${T}/live/calibrate-config`)).json();
if (cfg.sound_check?.state === "vermelho" && cfg.sound_check_pending === false) pass("vermelho_persistido", { reasons: cfg.sound_check.reasons });
else fail("vermelho_persistido", JSON.stringify(cfg.sound_check));

// 5. lista do professor (rota /w/:wt/info, entrevista) mostra o estado
const info = await (await fetch(`${BASE}/w/${work.work_token}/info`)).json();
const row = (info.submissions || []).find(s => s.submission_token === T);
if (row?.sound_check?.state === "vermelho") pass("professor_lista", {});
else fail("professor_lista", JSON.stringify(row?.sound_check));

// 6. waive destrava
await fetch(`${BASE}/w/${work.work_token}/submissions/${T}/waive-soundcheck`, { method: "POST" });
cfg = await (await fetch(`${BASE}/s/${T}/live/calibrate-config`)).json();
if (cfg.sound_check?.waived === true && cfg.sound_check_pending === false) pass("waive", {});
else fail("waive", JSON.stringify(cfg.sound_check));

// 7. eco 2x com vazamento em outra submissão -> vermelho por eco
const [sub2] = await db.createSubmissions(work.id, "SC-live-2", 1, true);
const T2 = sub2.submission_token;
await postAudio(`${BASE}/s/${T2}/live/calibrate`, goodBuf, { attempt: "1" });
await postAudio(`${BASE}/s/${T2}/live/echo-check`, leakBuf);
const e3 = await postAudio(`${BASE}/s/${T2}/live/echo-check`, leakBuf);
if (e3.sound_check?.state === "vermelho" && e3.sound_check.echo_leaks === 2) pass("vermelho_por_eco", {});
else fail("vermelho_por_eco", JSON.stringify(e3.sound_check));

// 8. hfp registrado aparece no detalhe (registro p/ telemetria)
const d = await db.getOralSubmissionDetail(sub.id);
if (d?.oral_calibration_json?.hfp && d.oral_calibration_json.echo) pass("registro_completo", { keys: Object.keys(d.oral_calibration_json) });
else fail("registro_completo", JSON.stringify(Object.keys(d?.oral_calibration_json || {})));

console.log(report.ok ? "\n✅ ESPELHO LIVE PASS" : "\n❌ ESPELHO LIVE FAIL");
process.exit(report.ok ? 0 : 1);

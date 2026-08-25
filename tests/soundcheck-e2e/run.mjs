// E2E do SOUND CHECK v2 (#288/ADR 0023) na página do aluno da PROVA ORAL.
//
// Dirige o navegador real (Playwright + Chrome) com microfone e câmera FALSOS:
// o mic é um MediaStream alimentado por nós (TTS fala a frase certa ou errada),
// a câmera é um canvas. Três jornadas, num run só:
//
//   A) teste obrigatório → 2 leituras ruins → eco → VERMELHO → persiste no
//      reload → professor vê e LIBERA → aluno segue;
//   B) VERMELHO → "Já ajustei — testar de novo" → leitura boa → AMARELO
//      (pior resultado registrado) → segue com aviso;
//   C) leitura boa de primeira → sem eco → VERDE → segue direto.
//
// CUSTO/OPT-IN: usa STT/TTS reais (centavos por execução). Exige servidor no ar.
//   RUN_SOUNDCHECK_E2E=1 node -r dotenv/config tests/soundcheck-e2e/run.mjs
//   E2E_BASE_HTTP (default http://127.0.0.1:5000)

import fs from "node:fs";
import OpenAI from "openai";
import { chromium } from "playwright-core";
import * as db from "../../lib/db.js";

if (process.env.RUN_SOUNDCHECK_E2E !== "1") {
    console.error("[sc-e2e] BLOQUEADO: use RUN_SOUNDCHECK_E2E=1 (gera custo pequeno de STT/TTS).");
    process.exit(2);
}
const BASE = process.env.E2E_BASE_HTTP || "http://127.0.0.1:5000";
const openai = new OpenAI();

const SENTENCE = "Esta prova fala de fotossíntese, molécula de água e a capital Brasília.";
const KEY_TERMS = ["fotossíntese", "Brasília"];
const WRONG = "Bananas amarelas voam no céu de inverno enquanto o relógio derrete devagar.";

const report = { steps: {}, ok: true };
const pass = (k, x) => { report.steps[k] = { ok: true, ...x }; console.log(`[sc-e2e] ✓ ${k}`, x ? JSON.stringify(x) : ""); };
const fail = (k, msg) => { report.steps[k] = { ok: false, msg }; report.ok = false; console.log(`[sc-e2e] ✗ ${k} — ${msg}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tts(text) {
    const r = await openai.audio.speech.create({ model: "gpt-4o-mini-tts", voice: "coral", input: text, response_format: "mp3" });
    return Buffer.from(await r.arrayBuffer()).toString("base64");
}

// Mic falso (alimentado por __speak) + câmera falsa (canvas). Ver inject.js do
// audio-e2e — aqui com trilha de VÍDEO porque a prova oral pede as duas.
const INJECT = `(() => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const silent = ctx.createConstantSource();
    const silentGain = ctx.createGain(); silentGain.gain.value = 0;
    silent.connect(silentGain); try { silent.start(); } catch (e) {}
    // A página chama getUserMedia MAIS DE UMA VEZ (mic+câmera no start, medidor
    // de ruído à parte): guardamos TODOS os destinos e a fala toca em todos —
    // o que estiver gravando ouve.
    const dests = [];
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const g = canvas.getContext("2d");
    setInterval(() => { g.fillStyle = (Date.now() / 400 | 0) % 2 ? "#889" : "#998"; g.fillRect(0, 0, 640, 480); }, 200);
    const vstream = canvas.captureStream(5);
    window.__speak = async (b64) => {
        if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }
        const bin = atob(b64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const buf = await ctx.decodeAudioData(bytes.buffer);
        const src = ctx.createBufferSource(); src.buffer = buf;
        for (const d of dests) src.connect(d);
        await new Promise(res => { src.onended = res; src.start(); });
        await new Promise(r => setTimeout(r, 300));
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        const dest = ctx.createMediaStreamDestination();
        silentGain.connect(dest);
        dests.push(dest);
        const tracks = [...dest.stream.getAudioTracks()];
        if (constraints && constraints.video) tracks.push(vstream.getVideoTracks()[0].clone());
        return new MediaStream(tracks);
    };
})();`;

async function launchChrome() {
    const args = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--no-default-browser-check"];
    try { return await chromium.launch({ channel: "chrome", headless: true, args }); }
    catch {
        const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(p => fs.existsSync(p));
        return await chromium.launch({ executablePath: exe, headless: true, args });
    }
}

// --- Helpers de página ---
async function openStudent(context, token) {
    const page = await context.newPage();
    page.on("pageerror", e => console.log("[sc-e2e][pageerror]", String(e).slice(0, 160)));
    await page.goto(`${BASE}/s/${token}`);
    await page.check("#accept");
    await page.click("#start-btn");
    await page.waitForSelector("#instr", { state: "visible", timeout: 20000 });
    return page;
}
const dialogText = (page) => page.evaluate(() => document.getElementById("setup-gate-dialog")?.innerText || null);
async function closeDialog(page) { await page.evaluate(() => { document.getElementById("sg-ok")?.click(); document.getElementById("sg-voltar")?.click(); }); }
async function readSentence(page, b64) {
    await page.click("#calib-rec-btn");
    await sleep(600); // MediaRecorder no ar
    await page.evaluate(b => window.__speak(b), b64);
    await page.click("#calib-rec-btn"); // parar e verificar
    await page.waitForFunction(() =>
        !/Verificando|Gravando/.test(document.getElementById("calib-status").textContent), null, { timeout: 30000 });
    return page.evaluate(() => document.getElementById("calib-status").textContent);
}
async function runEchoUi(page) {
    await page.click("#echo-btn");
    await page.waitForFunction(() => {
        const t = document.getElementById("echo-status").textContent;
        return /Sem eco|Eco detectado|Não consegui/.test(t);
    }, null, { timeout: 60000 });
    return page.evaluate(() => document.getElementById("echo-status").textContent);
}
const redVisible = (page) => page.evaluate(() => (document.getElementById("sc-red").innerHTML || "").length > 0);
async function infoRow(workToken, subToken) {
    const info = await (await fetch(`${BASE}/w/${workToken}/oral/info`)).json();
    return (info.submissions || []).find(s => s.submission_token === subToken);
}

async function main() {
    // Seed: trabalho oral com frase de calibração + 3 tokens de teste.
    const work = await db.createWork("E2E Sound Check", 10, "oral_realtime");
    await db.setOralQuestions(work.id, [{ id: 1, question: "O que é fotossíntese?", answer: "Processo de produção de glicose com luz.", rubric: "10: correta. 7,5: quase. 5: parcial. 2,5: fraca. 0: errada." }]);
    await db.setWorkVoice(work.id, "coral"); // (sem sessão de voz aqui — só a página 1)
    await db.setOralCalibration(work.id, { sentence: SENTENCE, key_terms: KEY_TERMS });
    const subs = await db.createSubmissions(work.id, "SC-E2E", 3, true);
    pass("seed", { work: work.work_token, subs: subs.map(s => s.submission_token) });

    const [goodB64, wrongB64] = await Promise.all([tts(SENTENCE), tts(WRONG)]);
    pass("tts", { good_kb: Math.round(goodB64.length * 3 / 4 / 1024), wrong_kb: Math.round(wrongB64.length * 3 / 4 / 1024) });

    const browser = await launchChrome();
    const context = await browser.newContext({ permissions: ["microphone", "camera"] });
    context.setDefaultTimeout(30000);
    await context.addInitScript(INJECT);

    try {
        // ---------- JORNADA A: obrigatório → vermelho → reload → liberação ----------
        const A = subs[0].submission_token;
        let page = await openStudent(context, A);
        // A1. Continuar sem testar → bloqueio "Falta o teste de captação"
        await page.check("#hp-check");
        await page.click("#to-check-btn");
        const d1 = await dialogText(page);
        if (d1 && /Falta o teste de captação/.test(d1)) pass("A1_gate_obrigatorio", {});
        else fail("A1_gate_obrigatorio", `diálogo: ${String(d1).slice(0, 120)}`);
        await closeDialog(page);
        // A2. Duas leituras ERRADAS → tentativas esgotadas + eco liberado
        const r1 = await readSentence(page, wrongB64);
        const r2 = await readSentence(page, wrongB64);
        const echoVisible = await page.evaluate(() => document.getElementById("echo-block").style.display !== "none");
        if (echoVisible) pass("A2_leituras_ruins", { r1: r1.slice(0, 60), r2: r2.slice(0, 60) });
        else fail("A2_leituras_ruins", `echo-block não apareceu (r2=${r2.slice(0, 120)})`);
        // A3. Eco (mic falso em silêncio → sem eco) e escada → VERMELHO
        const e1 = await runEchoUi(page);
        await sleep(300);
        if (await redVisible(page)) pass("A3_vermelho", { echo: e1.slice(0, 40) });
        else fail("A3_vermelho", `painel vermelho não apareceu (echo=${e1.slice(0, 80)})`);
        // A4. Continuar → bloqueado pelo vermelho
        await page.click("#to-check-btn");
        const d2 = await dialogText(page);
        if (d2 && /reprovou/.test(d2)) pass("A4_gate_vermelho", {});
        else fail("A4_gate_vermelho", `diálogo: ${String(d2).slice(0, 120)}`);
        await closeDialog(page);
        // A5. Reload → vermelho persiste (o reload volta ao consentimento; reentra)
        await page.reload();
        await page.check("#accept"); await page.click("#start-btn");
        await page.waitForSelector("#instr", { state: "visible" });
        await sleep(800);
        if (await redVisible(page)) pass("A5_reload_persiste", {});
        else fail("A5_reload_persiste", "painel vermelho sumiu no reload");
        // A6. Professor vê vermelho e libera; aluno segue
        const rowA = await infoRow(work.work_token, A);
        if (rowA?.sound_check?.state === "vermelho" && !rowA.sound_check.waived) pass("A6_professor_ve", { reasons: rowA.sound_check.reasons });
        else fail("A6_professor_ve", JSON.stringify(rowA?.sound_check));
        await fetch(`${BASE}/w/${work.work_token}/submissions/${A}/waive-soundcheck`, { method: "POST" });
        await page.reload();
        await page.check("#accept"); await page.click("#start-btn");
        await page.waitForSelector("#instr", { state: "visible" });
        await sleep(800);
        await page.check("#hp-check");
        await page.click("#to-check-btn");
        await sleep(500);
        const setupVisible = await page.evaluate(() => document.getElementById("setup").style.display !== "none");
        if (setupVisible && !(await redVisible(page))) pass("A7_liberado_segue", {});
        else fail("A7_liberado_segue", `setup=${setupVisible} red=${await redVisible(page)} dialog=${String(await dialogText(page)).slice(0, 100)}`);
        await page.close();

        // ---------- JORNADA B: vermelho → recuperação → amarelo ----------
        const B = subs[1].submission_token;
        page = await openStudent(context, B);
        await page.check("#hp-check");
        await readSentence(page, wrongB64);
        await readSentence(page, wrongB64);
        await runEchoUi(page);
        await sleep(300);
        if (await redVisible(page)) pass("B1_vermelho", {});
        else fail("B1_vermelho", "não ficou vermelho após 2 leituras ruins + eco");
        await page.click("#sc-retry-btn");
        const r3 = await readSentence(page, goodB64);
        await sleep(300);
        const rowB = await infoRow(work.work_token, B);
        if (!(await redVisible(page)) && rowB?.sound_check?.state === "amarelo") pass("B2_recupera_amarelo", { leitura: r3.slice(0, 50), reasons: rowB.sound_check.reasons });
        else fail("B2_recupera_amarelo", `red=${await redVisible(page)} estado=${rowB?.sound_check?.state} leitura=${r3.slice(0, 120)}`);
        // B3. Continuar → aviso não-bloqueante ("Continuar assim mesmo")
        await page.click("#to-check-btn");
        const d3 = await dialogText(page);
        if (d3 && /instabilidade|assim mesmo/i.test(d3)) {
            await page.evaluate(() => document.getElementById("sg-seguir")?.click());
            await sleep(500);
            const ok = await page.evaluate(() => document.getElementById("setup").style.display !== "none");
            if (ok) pass("B3_amarelo_segue", {});
            else fail("B3_amarelo_segue", "não avançou após 'Continuar assim mesmo'");
        } else fail("B3_amarelo_segue", `diálogo: ${String(d3).slice(0, 120)}`);
        await page.close();

        // ---------- JORNADA C: verde direto ----------
        const C = subs[2].submission_token;
        page = await openStudent(context, C);
        await page.check("#hp-check");
        const rc = await readSentence(page, goodB64);
        if (/Leitura ok/.test(rc)) pass("C1_leitura_ok", {});
        else fail("C1_leitura_ok", rc.slice(0, 120));
        const ec = await runEchoUi(page);
        if (/Sem eco/.test(ec)) pass("C2_sem_eco", {});
        else fail("C2_sem_eco", ec.slice(0, 120));
        const rowC = await infoRow(work.work_token, C);
        if (rowC?.sound_check?.state === "verde") pass("C3_verde", {});
        else fail("C3_verde", JSON.stringify(rowC?.sound_check));
        await page.click("#to-check-btn");
        await sleep(500);
        const dC = await dialogText(page);
        const setupC = await page.evaluate(() => document.getElementById("setup").style.display !== "none");
        if (setupC && !dC) pass("C4_verde_segue_direto", {});
        else fail("C4_verde_segue_direto", `setup=${setupC} dialog=${String(dC).slice(0, 100)}`);
        await page.close();
    } finally {
        await browser.close();
    }

    console.log("\n========== RESUMO E2E SOUND CHECK ==========");
    for (const [k, v] of Object.entries(report.steps)) console.log(`${v.ok ? "PASS" : "FAIL"}  ${k}${v.ok ? "" : " — " + v.msg}`);
    console.log(`\nRESULTADO GERAL: ${report.ok ? "✅ PASS" : "❌ FAIL"}`);
    process.exit(report.ok ? 0 : 1);
}

main().catch(e => { console.error("[sc-e2e] erro fatal:", e); process.exit(1); });

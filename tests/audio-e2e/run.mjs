// Harness E2E do MODO ÁUDIO do super-ta.
//
// Fluxo: garante infra (DB + servidor) -> seed de um trabalho em áudio ->
// abre a student.html num Chrome controlado com microfone falso -> conduz a
// entrevista inteira (simulador de aluno responde dinamicamente a cada pergunta
// real do entrevistador) -> baixa os áudios e escreve um relatório.
//
// Uso:
//   node tests/audio-e2e/run.mjs [--persona bem_preparado] [--voice coral]
//        [--questions 3] [--headed] [--keep-server] [--base http://localhost:5000]
//
// Limitação honesta: o harness NAO julga qualidade de voz. Ele verifica que a
// cadeia grava->STT->orquestrador->TTS->reproducao funciona, captura o texto de
// tudo (perguntas e respostas), erros de console/áudio, e salva os mp3 pra
// auditoria humana.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { seed, seedRemote } from "./seed.mjs";
import { PERSONAS, nextAnswer, speak } from "./student.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---- CLI ----
function parseArgs(argv) {
    // 127.0.0.1 (não "localhost"): o fetch do Node resolve localhost para IPv6
    // (::1) primeiro, mas o servidor escuta em IPv4 (0.0.0.0) — localhost falha.
    const a = { persona: "bem_preparado", voice: "coral", questions: 3, headed: false, keepServer: false, base: "http://127.0.0.1:5000", work: null, pdf: null, workText: null };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === "--persona") a.persona = argv[++i];
        else if (v === "--voice") a.voice = argv[++i];
        else if (v === "--questions") a.questions = Number(argv[++i]);
        else if (v === "--headed") a.headed = true;
        else if (v === "--keep-server") a.keepServer = true;
        else if (v === "--base") a.base = argv[++i];
        // Modo remoto (ambiente de teste/prod): trabalho já existente; cunha só
        // uma submissão via token, sem login. --voice/--questions são ignorados.
        else if (v === "--work") a.work = argv[++i];
        // --pdf: usa ESTE PDF como o trabalho (em vez do PDF de teste padrão).
        // --work-text: texto do trabalho para o aluno-simulador responder ancorado.
        else if (v === "--pdf") a.pdf = argv[++i];
        else if (v === "--work-text") a.workText = argv[++i];
    }
    return a;
}
const ARGS = parseArgs(process.argv.slice(2));

const log = (...m) => console.log(...m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Infra: garante DB + servidor no ar ----
async function pingServer(base) {
    try {
        const res = await fetch(base + "/me", { method: "GET" });
        return res.status === 200 || res.status === 401; // 401 = no ar, sem sessão
    } catch { return false; }
}

async function ensureServer(base) {
    if (await pingServer(base)) {
        log(`[infra] servidor ja responde em ${base}`);
        return { started: false, proc: null };
    }
    log("[infra] subindo Postgres (docker compose) + migrations...");
    execSync("npm run db:up", { cwd: PROJECT_ROOT, stdio: "inherit" });
    execSync("npm run db:migrate", { cwd: PROJECT_ROOT, stdio: "inherit" });

    log("[infra] iniciando servidor (node server.js)...");
    const logFile = path.join(__dirname, "server.out.log");
    const out = fs.openSync(logFile, "w");
    const proc = spawn("node", ["server.js"], {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", out, out],
        env: process.env,
    });
    // Espera subir (ate 60s).
    for (let i = 0; i < 120; i++) {
        if (await pingServer(base)) {
            log(`[infra] servidor no ar (log: ${logFile})`);
            return { started: true, proc };
        }
        if (proc.exitCode != null) {
            throw new Error(`servidor saiu com codigo ${proc.exitCode}. Veja ${logFile}`);
        }
        await sleep(500);
    }
    throw new Error(`servidor nao subiu em 60s. Veja ${logFile}`);
}

// ---- Parser do corpo do /chat (SSE ou JSON) ----
function parseChatBody(contentType, body) {
    if (contentType.includes("text/event-stream")) {
        let result = null, error = null;
        for (const chunk of body.split("\n\n")) {
            let ev = "message", data = "";
            for (const line of chunk.split("\n")) {
                if (line.startsWith("event:")) ev = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (ev === "result") { try { result = JSON.parse(data); } catch {} }
            else if (ev === "error") { try { error = JSON.parse(data); } catch { error = { message: data }; } }
        }
        if (error) throw new Error(`SSE error: ${error.message || error.error || "?"}`);
        if (!result) throw new Error("SSE sem result");
        return result;
    }
    return JSON.parse(body);
}

// Extrai o texto da fala do entrevistador de um payload do /chat ou /upload.
function questionTextOf(payload) {
    return payload.assistant || payload.assistant_response || "";
}

// ---- Download de áudio do entrevistador (auth via token na URL) ----
async function downloadAudio(base, audioUrl, destPath) {
    if (!audioUrl) return false;
    const url = audioUrl.startsWith("http") ? audioUrl : base + audioUrl;
    try {
        const res = await fetch(url);
        if (!res.ok) return false;
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(destPath, buf);
        return true;
    } catch { return false; }
}

async function main() {
    const persona = PERSONAS[ARGS.persona];
    if (!persona) throw new Error(`persona desconhecida: ${ARGS.persona}. Opcoes: ${Object.keys(PERSONAS).join(", ")}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(__dirname, "runs", stamp);
    const audioDir = path.join(outDir, "audio");
    fs.mkdirSync(audioDir, { recursive: true });

    const report = {
        startedAt: new Date().toISOString(),
        config: { ...ARGS, personaName: persona.name },
        seed: null,
        turns: [],
        consoleErrors: [],
        pageErrors: [],
        errors: [],
        finishedPhase: null,
        ok: false,
    };

    let server = { started: false, proc: null };
    let browser = null;

    try {
        let s;
        if (ARGS.work) {
            // Modo remoto: alvo já no ar (dev/prod). NÃO sobe servidor local.
            if (!(await pingServer(ARGS.base))) {
                throw new Error(`alvo remoto não respondeu em ${ARGS.base}/me — confira a URL`);
            }
            log(`[infra] alvo remoto: ${ARGS.base} (sem servidor local)`);
            log(`[seed-remoto] usando trabalho existente ${ARGS.work} (sem login). --voice/--questions ignorados (vêm da config do trabalho).`);
            s = await seedRemote({ base: ARGS.base, workToken: ARGS.work });
        } else {
            server = await ensureServer(ARGS.base);
            log(`[seed] criando trabalho em modo audio (voz=${ARGS.voice}, perguntas=${ARGS.questions})...`);
            s = await seed({ base: ARGS.base, voice: ARGS.voice, questionCount: ARGS.questions });
            // Desde a reforma da entrevista (#177), TODA entrevista nasce com
            // fiscalização por vídeo LIGADA (fixo, sem UI do professor). Este
            // harness testa a CADEIA DE ÁUDIO (mic falso, sem câmera) — o setup
            // de câmera/posição/gestos é intestável aqui (MediaPipe sobre canvas).
            // Andaime de teste: desliga a fiscalização SÓ no trabalho semeado,
            // direto no banco (a coluna segue honrada pelo produto).
            {
                const db = await import("../../lib/db.js");
                const w = await db.getWorkByToken(s.workToken);
                await db.setProctoringEnabled(w.id, false);
                log("[seed] fiscalização desligada no trabalho de teste (andaime; ver #177/ADR 0005)");
            }
        }
        // --pdf: substitui o PDF de teste padrão pelo trabalho real informado.
        if (ARGS.pdf) {
            s.trabalhoPdf = fs.readFileSync(ARGS.pdf);
            log(`[seed] usando PDF informado: ${path.basename(ARGS.pdf)} (${(s.trabalhoPdf.length / 1024).toFixed(0)} KB)`);
        }
        // --work-text: texto do trabalho p/ o aluno-simulador responder ancorado.
        let workText = null;
        if (ARGS.workText) {
            workText = fs.readFileSync(ARGS.workText, "utf8");
            log(`[seed] aluno ancorado no texto do trabalho (${(workText.length / 1000).toFixed(0)}k chars)`);
        }
        report.seed = { workToken: s.workToken, subToken: s.subToken, studentUrl: s.studentUrl, remote: !!ARGS.work };
        log(`[seed] aluno: ${s.studentUrl}`);

        // ---- Browser ----
        log(`[browser] lancando Chrome (${ARGS.headed ? "headed" : "headless"})...`);
        const launchArgs = [
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",
            "--no-default-browser-check",
        ];
        const launchOpts = { headless: !ARGS.headed, args: launchArgs };
        // Em ambientes sem Google Chrome instalado (ex.: NixOS/Replit), aponte
        // PLAYWRIGHT_CHROME_PATH para um Chromium compatível. Sem a variável, o
        // comportamento original (channel:"chrome") é preservado.
        const envExe = process.env.PLAYWRIGHT_CHROME_PATH;
        try {
            if (envExe) {
                browser = await chromium.launch({
                    executablePath: envExe,
                    ...launchOpts,
                    args: [...launchArgs, "--no-sandbox", "--disable-setuid-sandbox"],
                });
            } else {
                browser = await chromium.launch({ channel: "chrome", ...launchOpts });
            }
        } catch (e) {
            // Fallback: caminhos comuns do Chrome no Windows.
            const candidates = [
                "C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
            ];
            const exe = candidates.find((p) => fs.existsSync(p));
            if (!exe) throw new Error(`Chrome nao encontrado (channel falhou: ${e.message})`);
            browser = await chromium.launch({ executablePath: exe, ...launchOpts });
        }
        const context = await browser.newContext({ permissions: ["microphone"] });
        context.setDefaultTimeout(120000); // TTS + reasoning podem demorar
        const injectJs = fs.readFileSync(path.join(__dirname, "inject.js"), "utf8");
        await context.addInitScript(injectJs);
        // Cronômetro de latência percebida: registra performance.now() a cada vez
        // que um <audio> começa a tocar ('playing', capture phase pois não
        // borbulha). Comparado ao instante do envio, mede "tempo até começar a
        // ouvir a voz do entrevistador". O áudio do aluno é injetado via
        // AudioContext (mic falso), não <audio>, então não contamina a medida.
        await context.addInitScript(() => {
            window.__superTAAudioPlays = [];
            document.addEventListener("playing", (e) => {
                if (e.target && e.target.tagName === "AUDIO") {
                    window.__superTAAudioPlays.push(performance.now());
                }
            }, true);
        });

        const page = await context.newPage();
        page.on("console", (msg) => {
            if (msg.type() === "error") report.consoleErrors.push(msg.text());
        });
        page.on("pageerror", (err) => report.pageErrors.push(String(err)));

        log(`[browser] abrindo ${s.studentUrl}`);
        await page.goto(s.studentUrl, { waitUntil: "domcontentloaded" });
        // Garante que a injeção esta ativa.
        await page.waitForFunction("window.__superTAReady === true", null, { timeout: 10000 });

        // Consentimento (se aparecer). O modal abre de forma assíncrona (fetch
        // /api/consent + showModal), então esperamos um instante por ele.
        async function handleConsent(waitMs = 3000) {
            const appeared = await page
                .waitForSelector("#consent-dialog[open]", { timeout: waitMs })
                .then(() => true)
                .catch(() => false);
            if (!appeared) return;
            log("[flow] aceitando consentimento");
            const cb = page.locator("#consent-checkbox");
            if (await cb.count()) await cb.check().catch(() => {});
            await page.locator("#consent-accept").click().catch(() => {});
            await page.waitForSelector("#consent-dialog:not([open])", { timeout: 10000 }).catch(() => {});
        }

        // Consentimento abre no load (bloqueia a tela). Aceita antes de tudo.
        await handleConsent(8000);

        // ---- Upload do trabalho (PDF) ----
        log("[flow] enviando PDF do trabalho");
        const uploadResp = page.waitForResponse(
            (r) => r.url().includes(`/s/${s.subToken}/upload`) && r.request().method() === "POST",
            { timeout: 180000 }
        );
        await page.locator("#file").setInputFiles({
            name: "trabalho.pdf",
            mimeType: "application/pdf",
            buffer: s.trabalhoPdf,
        });
        await page.locator("#sendFile").click();
        await handleConsent(); // consent pode disparar no clique
        const uploadRes = await uploadResp;
        const uploadPayload = parseChatBody(uploadRes.headers()["content-type"] || "", await uploadRes.text());
        let currentQuestion = questionTextOf(uploadPayload);
        log(`[entrevistador] ${currentQuestion.slice(0, 120)}`);

        // baixa audio da saudacao
        await downloadAudio(ARGS.base, uploadPayload.audio_url, path.join(audioDir, "turn00_entrevistador.mp3"));

        // Modo áudio: o "orientador" aparece com um checkbox "Ciente" que LIBERA
        // a fala do entrevistador. Sem marcar, a saudação nunca toca e a área de
        // gravação nunca aparece.
        const ciente = await page
            .waitForSelector(".ciente-check", { timeout: 30000 })
            .then((el) => el)
            .catch(() => null);
        if (ciente) {
            await ciente.check().catch(() => {});
            log('[flow] orientador: marcado "Ciente"');
        }

        // ---- Loop de turnos ----
        const history = [{ role: "interviewer", text: currentQuestion }];
        const MAX_TURNS = ARGS.questions * 3 + 8; // guarda contra loop infinito
        let turnN = 0;
        let phase = "intro";

        while (turnN < MAX_TURNS) {
            turnN++;

            // 1. Gera a fala do aluno pra pergunta atual.
            log(`[turno ${turnN}] gerando resposta do aluno (${persona.name})...`);
            const answerText = await nextAnswer({ persona, history, question: currentQuestion, workText });
            log(`[aluno] ${answerText.slice(0, 120)}`);
            const b64 = await speak(answerText, persona.voice);
            fs.writeFileSync(path.join(audioDir, `turn${String(turnN).padStart(2, "0")}_aluno.mp3`), Buffer.from(b64, "base64"));
            history.push({ role: "student", text: answerText });

            // 2. Grava + fala + envia. Prepara a espera da resposta ANTES de enviar.
            await page.locator("#record-btn").click(); // auto-espera o entrevistador terminar de falar
            // Confirma que a gravação iniciou de fato (UI 'recording' revela o
            // botão Enviar removendo a CLASSE .hidden). Se não revelar, o
            // MediaRecorder não começou — falha cedo em vez de "falar" no vazio.
            await page.locator("#stop-send-btn").waitFor({ state: "visible", timeout: 20000 });
            await page.evaluate((b) => window.__superTASpeak(b), b64); // "fala" no mic falso

            const chatResp = page.waitForResponse(
                (r) => r.url().includes(`/s/${s.subToken}/chat`) && r.request().method() === "POST",
                { timeout: 180000 }
            );
            // Instante do envio no relógio do browser (mesma origem dos plays).
            const tSend = await page.evaluate(() => performance.now());
            await page.locator("#stop-send-btn").click();
            const res = await chatResp;
            const payload = parseChatBody(res.headers()["content-type"] || "", await res.text());

            // Latência percebida: espera o áudio do entrevistador começar a tocar
            // e mede do envio até o 1º som após o envio.
            let perceivedMs = null;
            await page.waitForFunction(
                (since) => (window.__superTAAudioPlays || []).some((t) => t > since),
                tSend,
                { timeout: 180000 }
            ).catch(() => {});
            const firstPlay = await page.evaluate((since) => {
                const arr = (window.__superTAAudioPlays || []).filter((t) => t > since);
                return arr.length ? Math.min(...arr) : null;
            }, tSend);
            if (firstPlay != null) perceivedMs = Math.round(firstPlay - tSend);

            const nextQuestion = questionTextOf(payload);
            const gated = payload.audio_intelligibility || null;
            if (payload.phase) phase = payload.phase;

            // baixa audio do entrevistador deste turno
            await downloadAudio(ARGS.base, payload.audio_url, path.join(audioDir, `turn${String(turnN).padStart(2, "0")}_entrevistador.mp3`));

            report.turns.push({
                n: turnN,
                question_to_student: currentQuestion,
                student_answer: answerText,
                interviewer_reply: nextQuestion,
                phase,
                perceived_ms: perceivedMs,
                audio_error: !!payload.audio_error,
                intelligibility_gate: gated ? { mode: gated.mode, attempt: gated.attempt, spans: gated.spans } : null,
            });
            log(`[entrevistador] ${nextQuestion.slice(0, 120)}  (phase=${phase}${gated ? `, gate=${gated.mode}` : ""})`);

            if (gated) {
                log(`[turno ${turnN}] AUDIO BARRADO pelo pre-gate (${gated.mode}) — repetindo`);
            }

            history.push({ role: "interviewer", text: nextQuestion });
            currentQuestion = nextQuestion;

            if (phase === "finalizing" || phase === "finalized") {
                log(`[flow] entrevista encerrada (phase=${phase})`);
                break;
            }
        }

        report.finishedPhase = phase;

        // ---- Transcript canonico pelo lado do professor ----
        // Só no modo local (com login/jar). No modo remoto não há sessão de
        // professor, então o relatório fica com o lado do aluno (transcript +
        // SSE por turno + áudios) — suficiente para validar a cadeia/C1.
        if (s.jar) {
            try {
                const convRes = await fetch(`${ARGS.base}/w/${s.workToken}/submissions/${s.subToken}/conversation`, {
                    headers: s.jar.header(),
                });
                if (convRes.ok) {
                    const conv = await convRes.json();
                    fs.writeFileSync(path.join(outDir, "professor-conversation.json"), JSON.stringify(conv, null, 2));
                }
            } catch (err) {
                report.errors.push(`professor conversation fetch: ${err.message}`);
            }
        } else {
            log("[seed-remoto] pulando relatório do lado do professor (sem login)");
        }

        report.ok = report.pageErrors.length === 0 && (phase === "finalizing" || phase === "finalized");

        await context.close();
    } catch (err) {
        report.errors.push(err.message);
        log(`[ERRO] ${err.message}`);
        if (err.stack) log(err.stack);
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (server.started && server.proc && !ARGS.keepServer) {
            log("[infra] encerrando servidor");
            try { server.proc.kill(); } catch {}
        } else if (server.started && ARGS.keepServer) {
            log(`[infra] servidor mantido no ar (pid=${server.proc.pid})`);
        }
    }

    // ---- Relatorio ----
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

    // transcript.md legivel
    const md = [];
    md.push(`# Entrevista de teste (modo áudio)`);
    md.push("");
    md.push(`- **Persona do aluno:** ${persona.name} (${ARGS.persona})`);
    md.push(`- **Voz do entrevistador:** ${ARGS.voice}`);
    md.push(`- **Fase final:** ${report.finishedPhase}`);
    md.push(`- **Turnos:** ${report.turns.length}`);
    md.push(`- **Erros de página:** ${report.pageErrors.length}  ·  **Erros de console:** ${report.consoleErrors.length}`);
    md.push(`- **Resultado:** ${report.ok ? "✅ OK" : "⚠️ revisar"}`);
    md.push("");
    for (const t of report.turns) {
        md.push(`## Turno ${t.n}${t.intelligibility_gate ? ` — ⚠️ áudio barrado (${t.intelligibility_gate.mode})` : ""}`);
        md.push(`**Entrevistador:** ${t.question_to_student}`);
        md.push("");
        md.push(`**Aluno (${persona.name}):** ${t.student_answer}`);
        md.push("");
        if (t.audio_error) md.push(`> ⚠️ audio_error neste turno`);
        md.push("");
    }
    fs.writeFileSync(path.join(outDir, "transcript.md"), md.join("\n"));

    log("");
    log("=".repeat(60));
    log(`Relatorio: ${outDir}`);
    log(`  report.json · transcript.md · professor-conversation.json · audio/`);
    log(`Resultado: ${report.ok ? "OK" : "REVISAR"} · turnos=${report.turns.length} · fase=${report.finishedPhase}`);
    if (report.pageErrors.length) log(`  pageErrors: ${report.pageErrors.length}`);
    log("=".repeat(60));

    process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(2);
});

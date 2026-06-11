// Probe focado da CAMADA ACÚSTICA (não é o harness de entrevista completa).
// Injeta WAVs barulhentos (do test bed FLEURS+GTZAN) como a fala do aluno e
// confere, ponta-a-ponta num navegador real:
//   - o medidor Web Audio da student.html calcula o SNR e o loga no console;
//   - o campo acoustic_snr vai no upload;
//   - o servidor combina (logprob + acústico) e roteia seguir/avisar/repetir;
//   - a resposta carrega a Dica/pedido de repetição certo.
//
// Reusa seed.mjs + inject.js. NÃO usa o simulador-LLM de aluno (injeta arquivos),
// então o custo é só: 1 saudação do entrevistador + STT/gate por inject.
//
// Uso: node tests/audio-e2e/acoustic_probe.mjs --base http://127.0.0.1:5001
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { seed } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const base = (process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:5001");

// Arquivos a injetar (esperado, com base no browser_snr calculado offline).
// Clipes do test bed FLEURS+GTZAN (não versionados; gerados em _audiotest/).
// Cobrem os três desfechos pela camada acústica. Ajuste os caminhos conforme o
// seu corpus local.
const CLIPS = [
    { label: "limpo (SNR alto -> espera seguir)", file: "_audiotest/mixed/05_clean.wav" },
    { label: "música moderada (SNR ~16 -> espera avisar)", file: "_audiotest/mixed/05_snr5.wav" },
    { label: "música forte (SNR ~5 -> espera repetir)", file: "_audiotest/mixed2/01_music-5.wav" },
];

function parseChatBody(ct, body) {
    if (ct.includes("text/event-stream")) {
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
        if (error) throw new Error(`SSE error: ${error.message || "?"}`);
        if (!result) throw new Error("SSE sem result");
        return result;
    }
    return JSON.parse(body);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log(`[probe] base=${base}`);
    const s = await seed({ base, questionCount: 3, log: (...m) => console.log(...m) });

    const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--no-default-browser-check"],
    });
    const context = await browser.newContext({ permissions: ["microphone"] });
    context.setDefaultTimeout(120000);
    await context.addInitScript(fs.readFileSync(path.join(__dirname, "inject.js"), "utf8"));

    const snrLog = [];
    const page = await context.newPage();
    page.on("console", (msg) => {
        const t = msg.text();
        if (t.includes("[acoustic]")) snrLog.push(t);
    });

    await page.goto(s.studentUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction("window.__superTAReady === true", null, { timeout: 10000 });

    async function handleConsent(waitMs = 6000) {
        const ok = await page.waitForSelector("#consent-dialog[open]", { timeout: waitMs }).then(() => true).catch(() => false);
        if (!ok) return;
        const cb = page.locator("#consent-checkbox");
        if (await cb.count()) await cb.check().catch(() => {});
        await page.locator("#consent-accept").click().catch(() => {});
        await page.waitForSelector("#consent-dialog:not([open])", { timeout: 10000 }).catch(() => {});
    }
    await handleConsent(8000);

    // Upload do PDF -> dispara a saudação do entrevistador.
    const uploadResp = page.waitForResponse((r) => r.url().includes(`/s/${s.subToken}/upload`) && r.request().method() === "POST", { timeout: 180000 });
    await page.locator("#file").setInputFiles({ name: "trabalho.pdf", mimeType: "application/pdf", buffer: s.trabalhoPdf });
    await page.locator("#sendFile").click();
    await handleConsent();
    await uploadResp;

    const ciente = await page.waitForSelector(".ciente-check", { timeout: 30000 }).catch(() => null);
    if (ciente) await ciente.check().catch(() => {});

    const results = [];
    for (const clip of CLIPS) {
        const b64 = fs.readFileSync(path.join(ROOT, clip.file)).toString("base64");
        await page.locator("#record-btn").click();
        await page.locator("#stop-send-btn").waitFor({ state: "visible", timeout: 20000 });
        snrLog.length = 0;
        await page.evaluate((b) => window.__superTASpeak(b), b64);
        const chatResp = page.waitForResponse((r) => r.url().includes(`/s/${s.subToken}/chat`) && r.request().method() === "POST", { timeout: 180000 });
        await page.locator("#stop-send-btn").click();
        const res = await chatResp;
        const payload = parseChatBody(res.headers()["content-type"] || "", await res.text());
        const gate = payload.audio_intelligibility || null;
        const hint = gate?.hint || null;
        await sleep(500);
        results.push({
            label: clip.label,
            snrConsole: snrLog.join(" | ") || "(sem log)",
            outcome: gate ? (gate.mode || "avisar/dica") : "seguir (sem gate)",
            hintKind: hint?.kind || null,
            hintTitle: hint?.title || null,
        });
        // dá um tempinho pro próximo turno liberar a vez
        await page.waitForSelector("#record-btn:not(.hidden)", { timeout: 60000 }).catch(() => {});
    }

    await context.close();
    await browser.close();

    console.log("\n" + "=".repeat(72));
    console.log("RESULTADO DO PROBE ACÚSTICO (ponta-a-ponta, navegador real)");
    console.log("=".repeat(72));
    for (const r of results) {
        console.log(`\n• ${r.label}`);
        console.log(`   console:  ${r.snrConsole}`);
        console.log(`   desfecho: ${r.outcome}${r.hintKind ? `  → Dica[${r.hintKind}]: "${r.hintTitle}"` : ""}`);
    }
    console.log("\n" + "=".repeat(72));
}

main().catch((e) => { console.error("FATAL:", e.message); if (e.stack) console.error(e.stack); process.exit(2); });

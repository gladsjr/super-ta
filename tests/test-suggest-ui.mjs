// Teste de fumaça da UI de sugestão (conversa de teste). Abre o student.html de
// uma submissão is_test num Chrome, faz upload, e — quando é a vez do aluno —
// verifica que o painel aparece, os botões certos por modo, e que "texto para eu
// ler" gera e mostra o teleprompter. Modo áudio (do seed). Requer servidor no ar.
// Uso: node tests/test-suggest-ui.mjs [--base http://127.0.0.1:5099] [--headed]
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { seed } from "./audio-e2e/seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const BASE = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://127.0.0.1:5099";
const HEADED = argv.includes("--headed");
let fails = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };

async function main() {
    const s = await seed({ base: BASE, voice: "coral", questionCount: 3 });
    const subR = await fetch(`${BASE}/w/${s.workToken}/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json", ...s.jar.header() },
        body: JSON.stringify({ label: "ui-test", is_test: true }),
    });
    const { submissions } = await subR.json();
    const tk = submissions[0].submission_token;
    console.log(`[seed] submissão is_test ${tk}`);

    const injectJs = fs.readFileSync(path.join(__dirname, "audio-e2e", "inject.js"), "utf8");
    const browser = await chromium.launch({
        channel: "chrome", headless: !HEADED,
        args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--no-default-browser-check"],
    });
    const context = await browser.newContext({ permissions: ["microphone"] });
    context.setDefaultTimeout(120000);
    await context.addInitScript(injectJs);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    try {
        await page.goto(`${BASE}/s/${tk}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction("window.__superTAReady === true", null, { timeout: 10000 });

        // Consentimento (se aparecer).
        const consent = await page.waitForSelector("#consent-dialog[open]", { timeout: 8000 }).then(() => true).catch(() => false);
        if (consent) {
            await page.locator("#consent-checkbox").check().catch(() => {});
            await page.locator("#consent-accept").click().catch(() => {});
            await page.waitForSelector("#consent-dialog:not([open])", { timeout: 10000 }).catch(() => {});
        }

        // Painel NÃO deve aparecer na tela de upload (antes de haver pergunta).
        const panelBeforeUpload = await page.locator("#test-suggest").isVisible();
        ok(!panelBeforeUpload, "painel oculto na tela de upload");

        // Upload do trabalho.
        const uploadResp = page.waitForResponse((r) => r.url().includes(`/s/${tk}/upload`) && r.request().method() === "POST", { timeout: 180000 });
        await page.locator("#file").setInputFiles({ name: "trabalho.pdf", mimeType: "application/pdf", buffer: s.trabalhoPdf });
        await page.locator("#sendFile").click();
        await uploadResp;
        const ciente = await page.waitForSelector(".ciente-check", { timeout: 30000 }).catch(() => null);
        if (ciente) await ciente.check().catch(() => {});

        // Quando for a vez do aluno, o painel deve ficar visível.
        await page.waitForSelector("#test-suggest:not(.hidden)", { timeout: 90000 });
        ok(true, "painel visível na vez do aluno");
        ok(await page.locator("#suggest-text-read").isVisible(), "botão 'texto para eu ler' visível (modo áudio)");
        ok(!(await page.locator("#suggest-fill").isVisible()), "botão de texto oculto (modo áudio)");

        // Gera uma sugestão para ler (perfil 'vago') e confere o teleprompter.
        await page.locator("#suggest-profile").selectOption("vago");
        await page.locator("#suggest-text-read").click();
        await page.waitForFunction(() => {
            const t = document.getElementById("suggest-readtext");
            return t && !t.classList.contains("hidden") && (t.textContent || "").length > 15;
        }, null, { timeout: 60000 });
        const tp = (await page.locator("#suggest-readtext").textContent()) || "";
        ok(tp.length > 15, `teleprompter preenchido: "${tp.slice(0, 80)}"`);

        ok(pageErrors.length === 0, `0 erros de página (got ${pageErrors.length}${pageErrors[0] ? ": " + pageErrors[0] : ""})`);
    } catch (err) {
        ok(false, `exceção no fluxo: ${err.message}`);
    } finally {
        await browser.close().catch(() => {});
    }

    console.log(fails ? `\nFALHAS: ${fails}` : `\nUI OK`);
    process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });

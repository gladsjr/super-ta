// Teste de fumaça da UI de sugestão (conversa de teste). Abre o student.html de
// uma submissão is_test num Chrome, faz upload, e — quando é a vez do aluno —
// verifica: o painel aparece com os botões certos por modo; "Gerar resposta"
// mostra o texto EDITÁVEL e libera "Enviar por voz"; e o "Enviar por voz" faz o
// round-trip completo (TTS->STT->orquestrador->fala fragmentada), validando o fix
// do nome do arquivo no STT E o player fragmentado (a vez do aluno tem de voltar,
// provando que o player não travou). Modo áudio (do seed). Requer servidor no ar.
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
        ok(await page.locator("#suggest-gen").isVisible(), "botão 'Gerar resposta' visível (modo áudio)");
        ok(!(await page.locator("#suggest-fill").isVisible()), "botão de texto oculto (modo áudio)");
        ok(!(await page.locator("#suggest-voice-send").isVisible()), "'Enviar por voz' oculto antes de gerar");

        // Passo 1: "Gerar resposta" (perfil 'vago') -> texto EDITÁVEL + botão de voz.
        await page.locator("#suggest-profile").selectOption("vago");
        await page.locator("#suggest-gen").click();
        await page.waitForFunction(() => {
            const t = document.getElementById("suggest-edit");
            return t && !t.classList.contains("hidden") && (t.value || "").length > 15;
        }, null, { timeout: 60000 });
        const gen = await page.locator("#suggest-edit").inputValue();
        ok(gen.length > 15, `texto gerado, editável: "${gen.slice(0, 80)}"`);
        ok(await page.locator("#suggest-voice-send").isVisible(), "'Enviar por voz' liberado após gerar");

        // Passo 2: "Enviar por voz" -> round-trip completo. Valida o fix do STT
        // (mp3 nomeado .mp3) e o player fragmentado (a vez do aluno volta).
        await page.locator("#suggest-voice-send").click();
        await page.waitForFunction(
            () => [...document.querySelectorAll(".msg.you")].some(e => /voz enviada/.test(e.textContent || "")),
            null, { timeout: 20000 });
        ok(true, "resposta por voz enviada (placeholder do aluno apareceu)");

        // O entrevistador responde e a vez VOLTA para o aluno (player não travou).
        await page.waitForSelector("#record-btn:not(.hidden)", { timeout: 180000 });
        ok(true, "vez do aluno liberada após a fala do entrevistador (player não travou)");

        // E o player do entrevistador consolidou a fala num único blob (replay
        // completo): o src do <audio> da bolha do entrevistador vira blob:.
        const replayOk = await page.waitForFunction(
            () => [...document.querySelectorAll(".msg.ta audio")].some(a => (a.currentSrc || a.src || "").startsWith("blob:")),
            null, { timeout: 20000 }).then(() => true).catch(() => false);
        ok(replayOk, "player do entrevistador consolidou a fala num blob (replay completo)");

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

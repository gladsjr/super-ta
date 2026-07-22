// Driver de entrevista de ÁUDIO SEM browser (headless, direto nos endpoints HTTP).
//
// Mesma interface do harness de browser (tests/audio-e2e/run.mjs): --work, --base,
// --pdf, --work-text, --persona. A diferença é o transporte: em vez de tocar áudio
// em tempo real num Chrome com microfone falso, o aluno simulado gera a fala,
// sintetiza em mp3 (chave de PRODUÇÃO, no processo do driver) e faz POST do áudio
// direto no /chat. O SERVIDOR faz exatamente o mesmo trabalho (STT do áudio do
// aluno, raciocínio, TTS do entrevistador) sob o work — então o CUSTO e a LATÊNCIA
// DE RESPOSTA do servidor (telemetria serverTimings, gravada no servidor) são os
// mesmos; o que some é só a espera de playback em tempo real (overhead do teste).
//
// SEPARAÇÃO DE CUSTO: o aluno simulado (nextAnswer + speak) usa a chave de PRODUÇÃO;
// só o lado do entrevistador (no servidor, sob o work de benchmark) usa a chave de
// benchmark. Igual ao harness de browser.
//
// Uso (servidor já no ar; work já configurado em áudio):
//   node -r dotenv/config tests/audio-e2e/direct.mjs --work <token> \
//     [--base http://127.0.0.1:5000] [--pdf <studentPDF>] [--work-text <txt>] \
//     [--persona dominante_generico] [--max-turns 30]

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedRemote } from "./seed.mjs";
import { PERSONAS, nextAnswer, speak } from "./student.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    // --pace <seg>: atraso ANTES de cada resposta do aluno, simulando o tempo que
    // um aluno real leva para pensar/responder. Testa o efeito do TTL do cache de
    // prompt da OpenAI (turnos espaçados podem perder cache → custo maior).
    const a = { base: "http://127.0.0.1:5000", work: null, pdf: null, workText: null, persona: "dominante_generico", maxTurns: 30, paceSec: 0 };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === "--base") a.base = argv[++i];
        else if (v === "--work") a.work = argv[++i];
        else if (v === "--pdf") a.pdf = argv[++i];
        else if (v === "--work-text") a.workText = argv[++i];
        else if (v === "--persona") a.persona = argv[++i];
        else if (v === "--max-turns") a.maxTurns = Number(argv[++i]);
        else if (v === "--pace") a.paceSec = Number(argv[++i]);
    }
    return a;
}

// Parser do corpo do /chat: SSE (áudio) ou JSON. Espelha tests/audio-e2e/run.mjs.
function parseChatBody(contentType, body) {
    if ((contentType || "").includes("text/event-stream")) {
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

// Normaliza o payload do /chat (SSE result OU json) para { assistant, phase, finalized }.
// O result de áudio pode vir aninhado em { response: {...} }.
function normalizeChat(payload) {
    const p = payload?.response || payload || {};
    const phase = p.phase || p.currentPhase || payload?.phase || payload?.currentPhase || null;
    const finalized = p.finalized === true || payload?.finalized === true || phase === "finalized" || phase === "finalizing";
    return { assistant: p.assistant ?? payload?.assistant ?? "", phase, finalized };
}

const log = (...m) => console.log(...m);

async function main() {
    const A = parseArgs(process.argv.slice(2));
    if (!A.work) throw new Error("--work <token> obrigatório");
    const persona = PERSONAS[A.persona];
    if (!persona) throw new Error(`persona desconhecida: ${A.persona} (opções: ${Object.keys(PERSONAS).join(", ")})`);

    // Alvo já no ar? (ping /me).
    const ping = await fetch(A.base + "/me").then(r => r.status === 200 || r.status === 401).catch(() => false);
    if (!ping) throw new Error(`servidor não respondeu em ${A.base}/me`);

    // Cunha uma submissão no work existente (endpoint público). Reusa o seed remoto.
    const s = await seedRemote({ base: A.base, workToken: A.work, log });
    const subToken = s.subToken;
    const studentPdf = A.pdf ? fs.readFileSync(A.pdf) : s.trabalhoPdf;
    const workText = A.workText ? fs.readFileSync(A.workText, "utf8") : null;
    log(`[direct] work=${A.work} sub=${subToken} pdf=${A.pdf ? path.basename(A.pdf) : "(teste padrão)"} persona=${A.persona}`);

    // /start
    const startRes = await fetch(`${A.base}/s/${subToken}/start`, { method: "POST" });
    if (!startRes.ok) throw new Error(`start: HTTP ${startRes.status} — ${(await startRes.text()).slice(0, 300)}`);

    // /upload (multipart "file") → dispara PrepBuilder e devolve a saudação.
    const upFd = new FormData();
    upFd.append("file", new Blob([studentPdf], { type: "application/pdf" }), "trabalho.pdf");
    const upRes = await fetch(`${A.base}/s/${subToken}/upload`, { method: "POST", body: upFd });
    if (!upRes.ok) throw new Error(`upload: HTTP ${upRes.status} — ${(await upRes.text()).slice(0, 300)}`);
    let { assistant, phase, finalized } = normalizeChat(await upRes.json());
    log(`[upload ok] saudação: ${String(assistant).slice(0, 90)}…`);

    const history = [];
    const t0 = Date.now();
    for (let turn = 1; turn <= A.maxTurns; turn++) {
        history.push({ role: "interviewer", text: assistant });
        log(`\n── ENTREVISTADOR (turno ${turn}, fase=${phase || "?"}) ──\n${String(assistant).slice(0, 240)}`);
        if (finalized) { log("\n[fim] entrevista finalizada."); break; }

        // Pace: espera antes de responder, simulando o tempo do aluno real. Testa o
        // TTL do cache (turnos espaçados podem perder cache → custo maior).
        if (A.paceSec > 0) await new Promise(r => setTimeout(r, A.paceSec * 1000));

        // Aluno simulado (chave de PRODUÇÃO): texto → áudio mp3.
        const replyText = await nextAnswer({ persona, history, question: assistant, workText });
        history.push({ role: "student", text: replyText });
        log(`── ALUNO ──\n${String(replyText).slice(0, 240)}`);
        const audioB64 = await speak(replyText, persona.voice);
        const mp3 = Buffer.from(audioB64, "base64");

        // POST do áudio no /chat (campo "audio"). Resposta em SSE (modo áudio).
        const fd = new FormData();
        fd.append("audio", new Blob([mp3], { type: "audio/mpeg" }), "student.mp3");
        const res = await fetch(`${A.base}/s/${subToken}/chat`, { method: "POST", body: fd });
        const ct = res.headers.get("content-type") || "";
        const bodyText = await res.text();
        if (!res.ok) throw new Error(`chat turno ${turn}: HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
        ({ assistant, phase, finalized } = normalizeChat(parseChatBody(ct, bodyText)));
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    log(`\n[done] sub=${subToken} turnos=${history.filter(h => h.role === "student").length} tempo=${secs}s`);
    // Custo e serverTimings ficam no servidor (work_cost_events + conversation_json);
    // a orquestração lê de lá. Aqui só reportamos o fluxo.
    process.exit(0);
}

main().catch(err => { console.error("[direct] ERRO:", err.message); process.exit(1); });

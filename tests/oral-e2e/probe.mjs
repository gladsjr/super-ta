// Probe de conectividade da PROVA ORAL (Realtime).
//
// De-risca o maior desconhecido: a OPENAI_API_KEY tem acesso a modelos Realtime?
// Cria um trabalho oral_realtime de teste, abre o relay WebSocket como "aluno"
// e escuta ~18s para confirmar que o examinador conecta e FALA (áudio PCM16).
//
// NÃO envia áudio do aluno — só verifica a perna servidor↔OpenAI. Uso:
//   node tests/oral-e2e/probe.mjs

import { WebSocket } from "ws";
import * as db from "../../lib/db.js";

const BASE_WS = process.env.E2E_BASE_WS || "ws://localhost:5000";

const QUESTIONS = [
    { id: 1, question: "Em uma frase, o que é fotossíntese?", answer: "Processo das plantas que converte luz solar, água e CO2 em glicose e oxigênio.", aspects: ["luz solar", "água e CO2", "produz glicose e oxigênio"] },
    { id: 2, question: "Qual é a capital do Brasil?", answer: "Brasília.", aspects: ["Brasília"] },
    { id: 3, question: "Quanto é dois mais dois?", answer: "Quatro.", aspects: ["quatro"] },
];

async function main() {
    const work = await db.createWork("E2E Oral Probe", 5, "oral_realtime");
    await db.setOralQuestions(work.id, QUESTIONS);
    await db.setQuestionCount(work.id, 3);
    await db.setWorkVoice(work.id, "verse");
    const [sub] = await db.createSubmissions(work.id, "Probe", 1, true);
    await db.setSubmissionConsentVersion(
        (await db.findSubmissionByToken(sub.submission_token)).id,
        "probe"
    );
    console.log(`[probe] work=${work.work_token} sub=${sub.submission_token}`);

    const url = `${BASE_WS}/s/${sub.submission_token}/oral/relay`;
    const ws = new WebSocket(url);
    let audioBytes = 0, audioFrames = 0;
    const events = [];

    ws.on("open", () => console.log(`[probe] WS aberto ${url}`));
    ws.on("message", (data, isBinary) => {
        if (isBinary) { audioBytes += data.length; audioFrames++; return; }
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        events.push(m.type + (m.state ? `:${m.state}` : ""));
        console.log(`[probe] evt ${m.type}${m.state ? " state=" + m.state : ""}${m.total_questions ? " n=" + m.total_questions : ""}`);
    });
    ws.on("error", (e) => console.error(`[probe] WS erro: ${e.message}`));
    ws.on("close", (code) => console.log(`[probe] WS fechado code=${code}`));

    await new Promise((r) => setTimeout(r, 18000));
    try { ws.close(); } catch {}
    await new Promise((r) => setTimeout(r, 1500));

    const secs = (audioBytes / 48000).toFixed(1); // PCM16 mono 24kHz = 48000 B/s
    console.log(`\n[probe] RESULTADO: audioFrames=${audioFrames} audioBytes=${audioBytes} (~${secs}s de fala do examinador)`);
    console.log(`[probe] eventos: ${events.join(", ")}`);
    const ok = audioBytes > 24000; // pelo menos ~0.5s de áudio
    console.log(`[probe] ${ok ? "PASS — Realtime conecta e o examinador fala" : "FAIL — sem áudio do examinador"}`);
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("[probe] erro fatal:", e); process.exit(1); });

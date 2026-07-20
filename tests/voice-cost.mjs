// Custo do MODO VOZ por REAPROVEITAMENTO — sem re-rodar as entrevistas.
//
// Voz = (raciocínio do modo texto, já medido) + TTS (voz do entrevistador) + STT
// (transcrição do aluno). A análise é sempre em texto, então o custo de LLM é o
// mesmo do run de texto. Aqui:
//  - TTS: EXATO, a partir dos textos do entrevistador já gravados (preço por caractere).
//  - STT: MEDIDO de verdade — sintetiza cada resposta do aluno (que já existe em
//    texto) e transcreve, lendo o usage real. (O custo de sintetizar é overhead do
//    teste, NÃO entra na conta — aluno real fala, não sintetiza.)
//  - LLM: reaproveitado de work_cost_events do trabalho de texto.
//
// Uso: node -r dotenv/config tests/voice-cost.mjs
//   TEXT_WORK=<work_token> (default: o run de texto 59e48221f4e2)

import pg from "pg";
import { openai } from "../lib/openaiClient.js";
import { toFile } from "openai";
import { loadPricing, computeTtsCost, computeSttCost } from "../lib/billing.js";

const TTS = "gpt-4o-mini-tts", STT = "gpt-4o-transcribe", VOICE = "alloy";
const TEXT_WORK = process.env.TEXT_WORK || "59e48221f4e2";
const CONC = Number(process.env.CONC || 3);
loadPricing();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const usd = n => `$${n.toFixed(4)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function median(xs) { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => xs.length ? sum(xs) / xs.length : 0;

async function poolRun(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    async function w() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
    return out;
}

// Sintetiza um texto e o transcreve → custo REAL de STT (lê usage em tokens).
async function sttCostForText(text) {
    for (let a = 0; a < 3; a++) {
        try {
            const speech = await openai.audio.speech.create({ model: TTS, voice: VOICE, input: text, response_format: "mp3" });
            const buf = Buffer.from(await speech.arrayBuffer());
            const tr = await openai.audio.transcriptions.create({ file: await toFile(buf, "a.mp3"), model: STT });
            const { cost_usd, input_tokens, output_tokens } = computeSttCost(tr.usage, STT);
            return { cost: cost_usd, in: input_tokens || 0, out: output_tokens || 0 };
        } catch (e) { if (a === 2) throw e; await sleep(1500 * (a + 1)); }
    }
}

// Extrai texto FALADO pelo entrevistador (TTS) e pelo aluno (STT) da conversa.
function extractSpeech(cj) {
    const interviewer = [], student = [];
    const introMsgs = cj.intro?.messages || [];
    for (const m of introMsgs) {
        if (!m.content) continue;
        if (m.role === "assistant") interviewer.push(m.content);
        else if (m.role === "user") student.push(m.content);
    }
    for (const t of (cj.turns || [])) {
        if (t.question) interviewer.push(t.question);
        if (t.answer) student.push(t.answer);
    }
    if (cj.finalization?.message) interviewer.push(cj.finalization.message);
    return { interviewer, student };
}

async function main() {
    console.log(`[cfg] trabalho de texto=${TEXT_WORK} | TTS=${TTS} STT=${STT} | conc=${CONC}`);

    // conversas
    const { rows: convs } = await pool.query(
        `SELECT s.submission_token AS tok, s.conversation_json AS cj
         FROM submissions s JOIN works w ON w.id = s.work_id
         WHERE w.work_token = $1 AND s.conversation_json IS NOT NULL ORDER BY s.id`, [TEXT_WORK]);
    console.log(`[dados] ${convs.length} conversas reaproveitadas`);

    // custo LLM do run de texto: conversa por aluno (com submission_id) + pós (sem)
    const { rows: convRows } = await pool.query(
        `SELECT s.submission_token AS tok, SUM(e.cost_usd)::float8 AS cost
         FROM work_cost_events e JOIN submissions s ON s.id = e.submission_id
         WHERE e.work_id = (SELECT id FROM works WHERE work_token = $1) GROUP BY s.submission_token`, [TEXT_WORK]);
    const conversaBySub = new Map(convRows.map(r => [r.tok, r.cost]));
    const { rows: posRows } = await pool.query(
        `SELECT COALESCE(SUM(e.cost_usd),0)::float8 AS cost FROM work_cost_events e
         WHERE e.work_id = (SELECT id FROM works WHERE work_token = $1) AND e.submission_id IS NULL`, [TEXT_WORK]);
    const posMean = posRows[0].cost / convs.length;

    const rows = await poolRun(convs, CONC, async (c) => {
        const cj = JSON.parse(c.cj);
        const { interviewer, student } = extractSpeech(cj);
        const ttsText = interviewer.join("\n");
        const tts = computeTtsCost(ttsText, TTS).cost_usd;
        let stt = 0, sttIn = 0, sttOut = 0;
        for (const ans of student) { const r = await sttCostForText(ans); stt += r.cost; sttIn += r.in; sttOut += r.out; }
        const llm = (conversaBySub.get(c.tok) || 0) + posMean;   // reaproveitado do texto
        return {
            tok: c.tok.slice(0, 10),
            chars_tts: ttsText.length, n_stt: student.length,
            tts, stt, sttIn, sttOut, llm,
            voice_total: llm + tts + stt,
            text_total: llm,
        };
    });

    for (const r of rows) console.log(`  ${r.tok}  LLM ${usd(r.llm)}  +TTS ${usd(r.tts)} (${r.chars_tts}c)  +STT ${usd(r.stt)} (${r.n_stt}x) = VOZ ${usd(r.voice_total)}`);

    const voice = rows.map(r => r.voice_total), text = rows.map(r => r.text_total);
    const ttsA = rows.map(r => r.tts), sttA = rows.map(r => r.stt);
    const deltas = rows.map(r => r.tts + r.stt);

    console.log(`\n=== CUSTO POR ENTREVISTA — MODO VOZ (reaproveitando o run de texto) ===`);
    console.log(`Modo: voz (áudio), 6 perguntas, aluno enrolado | ${convs.length} entrevistas`);
    // O raciocínio é REAPROVEITADO do run de texto — o rótulo correto é o do
    // modelo que gerou aquele run (ver o cost-estimate-*.json correspondente).
    console.log(`Modelos: raciocínio do run de texto (TEXT_WORK=${TEXT_WORK}) + ${TTS} (voz) + ${STT} (transcrição)`);
    console.log(`\n  VOZ ponta-a-ponta:  MÉDIA ${usd(mean(voice))} | MEDIANA ${usd(median(voice))} | faixa ${usd(Math.min(...voice))}…${usd(Math.max(...voice))}`);
    console.log(`  (texto ponta-a-ponta: méd ${usd(mean(text))})`);
    console.log(`\n  DELTA da voz (TTS+STT): méd ${usd(mean(deltas))} | med ${usd(median(deltas))}`);
    console.log(`    ├─ TTS (entrevistador): méd ${usd(mean(ttsA))} | med ${usd(median(ttsA))}`);
    console.log(`    └─ STT (aluno):         méd ${usd(mean(sttA))} | med ${usd(median(sttA))}`);
    const voiceOverText = mean(deltas) / mean(text) * 100;
    console.log(`\n  A voz adiciona ~${voiceOverText.toFixed(1)}% sobre o custo do modo texto.`);

    const report = {
        text_work: TEXT_WORK, n: convs.length, method: "reaproveitamento (LLM do texto + TTS exato + STT medido)",
        voice_end_to_end_usd: { mean: mean(voice), median: median(voice), min: Math.min(...voice), max: Math.max(...voice) },
        text_end_to_end_usd: { mean: mean(text) },
        delta_usd: { mean: mean(deltas), median: median(deltas) },
        tts_usd: { mean: mean(ttsA), median: median(ttsA) },
        stt_usd: { mean: mean(sttA), median: median(sttA) },
        per_sub: rows,
    };
    const fs = await import("node:fs"); const path = await import("node:path"); const { fileURLToPath } = await import("node:url");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs-text");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `voice-cost-${TEXT_WORK}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nRelatório: ${out}`);
    await pool.end();
}

main().catch(async e => { console.error("ERRO:", e.message); try { await pool.end(); } catch {} process.exit(1); });

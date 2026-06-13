// Agrega a telemetria de latência das execuções do harness de áudio.
//
// Lê, para cada pasta de run em tests/audio-e2e/runs/<stamp>/:
//   - report.json            → turns[].perceived_ms  (latência percebida client-side)
//   - professor-conversation.json → server_timings[] (decomposição server-side)
//
// Uso:
//   node tests/audio-e2e/analyze.mjs <run...>                 # um grupo
//   node tests/audio-e2e/analyze.mjs <runA...> :: <runB...>   # compara A (baseline) vs B (fragmentado)
//
// Cada <run> é um nome de pasta dentro de runs/ (ou um caminho). Sem args,
// usa TODAS as pastas em runs/ como um único grupo.
//
// Reporta, por grupo: n de turnos medidos, perceived_ms {média, mediana, p90},
// a decomposição média do server (stt / até-1º-token / TTS / etc.) e a fração
// do tempo que é TTS — o número que decide o GATE do plano. Com dois grupos,
// imprime o delta e a % de redução de perceived_ms.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, "runs");

function resolveRun(name) {
    if (fs.existsSync(name) && fs.statSync(name).isDirectory()) return name;
    const inRuns = path.join(RUNS_DIR, name);
    if (fs.existsSync(inRuns)) return inRuns;
    throw new Error(`run não encontrada: ${name}`);
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); }
    catch { return null; }
}

function stats(arr) {
    const a = arr.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return { n: 0, mean: null, median: null, p90: null, min: null, max: null };
    const sum = a.reduce((s, x) => s + x, 0);
    const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
    const mid = Math.floor(a.length / 2);
    return {
        n: a.length,
        mean: Math.round(sum / a.length),
        median: Math.round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2),
        p90: Math.round(q(0.9)),
        min: Math.round(a[0]),
        max: Math.round(a[a.length - 1]),
    };
}

// Coleta métricas de um grupo de runs.
function collect(runDirs) {
    const perceived = [];
    const server = { stt_ms: [], think_to_first_token_ms: [], first_token_to_tts_ms: [], tts_first_ms: [], tts_ms: [], tts_to_done_ms: [], total_ms: [] };
    let runs = 0, withTimings = 0;
    for (const name of runDirs) {
        const dir = resolveRun(name);
        const report = readJson(path.join(dir, "report.json"));
        const conv = readJson(path.join(dir, "professor-conversation.json"));
        if (report) {
            runs++;
            for (const t of report.turns ?? []) {
                if (typeof t.perceived_ms === "number") perceived.push(t.perceived_ms);
            }
        }
        // O endpoint /conversation embrulha o log em { work, submission, conversation }.
        // Aceita tanto o arquivo do harness quanto um conversation_json cru.
        const st = conv?.conversation?.server_timings ?? conv?.server_timings ?? [];
        if (st.length) withTimings++;
        for (const r of st) {
            for (const k of Object.keys(server)) {
                if (typeof r[k] === "number") server[k].push(r[k]);
            }
        }
    }
    const serverStats = {};
    for (const k of Object.keys(server)) serverStats[k] = stats(server[k]);
    return { runs, withTimings, perceived: stats(perceived), server: serverStats };
}

function fmt(s) {
    if (!s || s.n === 0) return "—";
    return `méd ${s.mean}ms · med ${s.median}ms · p90 ${s.p90}ms · n=${s.n}`;
}

function printGroup(label, g) {
    console.log(`\n=== ${label} ===`);
    console.log(`runs: ${g.runs}  (com server_timings: ${g.withTimings})`);
    console.log(`perceived (send→1º som):  ${fmt(g.perceived)}`);
    console.log(`server breakdown (média):`);
    const sv = g.server;
    const line = (lbl, s) => console.log(`  ${lbl.padEnd(26)} ${s.mean != null ? s.mean + "ms" : "—"}`);
    line("STT", sv.stt_ms);
    line("STT→1º token (raciocínio)", sv.think_to_first_token_ms);
    line("1º token→início TTS", sv.first_token_to_tts_ms);
    line("TTS até 1ª sentença", sv.tts_first_ms);
    line("TTS total (síntese+download)", sv.tts_ms);
    line("TTS→resposta enviada", sv.tts_to_done_ms);
    line("total server (recv→done)", sv.total_ms);
    // GATE: fração do tempo percebido que é TTS.
    if (sv.tts_ms.mean != null && g.perceived.mean) {
        const frac = sv.tts_ms.mean / g.perceived.mean;
        console.log(`  → TTS é ${(frac * 100).toFixed(0)}% do tempo percebido (GATE: <10% = não compensa fragmentar)`);
    }
}

function main() {
    const argv = process.argv.slice(2);
    const sepIdx = argv.indexOf("::");
    let groupA, groupB = null;
    if (sepIdx >= 0) {
        groupA = argv.slice(0, sepIdx);
        groupB = argv.slice(sepIdx + 1);
    } else if (argv.length) {
        groupA = argv;
    } else {
        groupA = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR) : [];
    }
    if (!groupA.length) { console.log("nenhuma run encontrada"); return; }

    const a = collect(groupA);
    printGroup(groupB ? "GRUPO A (baseline)" : "GRUPO", a);
    if (groupB && groupB.length) {
        const b = collect(groupB);
        printGroup("GRUPO B (fragmentado)", b);
        if (a.perceived.mean != null && b.perceived.mean != null) {
            const d = b.perceived.mean - a.perceived.mean;
            const pct = ((d / a.perceived.mean) * 100).toFixed(1);
            console.log(`\n=== DELTA (B − A) ===`);
            console.log(`perceived média: ${a.perceived.mean}ms → ${b.perceived.mean}ms  (${d >= 0 ? "+" : ""}${d}ms, ${pct}%)`);
            console.log(`perceived mediana: ${a.perceived.median}ms → ${b.perceived.median}ms`);
            console.log(`perceived p90: ${a.perceived.p90}ms → ${b.perceived.p90}ms`);
        }
    }
    console.log("");
}

main();

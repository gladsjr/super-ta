// Orquestra um LOTE de entrevistas de BENCHMARK DE CUSTO em modo áudio.
//
// Para cada item (pasta de enunciado × nível fraco/medio/bom) monta, do zero, um
// work de benchmark (is_benchmark=true, mesmo benchmark_run_id) já configurado
// para áudio (enunciado + entrevistador + voz + nº de perguntas) e dispara o
// harness de áudio existente (tests/audio-e2e/run.mjs) contra ele — o harness
// cunha a submissão, sobe o PDF do aluno e conduz a entrevista com um aluno
// SIMULADO que responde por voz.
//
// SEPARAÇÃO DE CUSTO (crítica): o simulador de aluno roda no PROCESSO DO HARNESS
// e usa a chave de PRODUÇÃO (gerar a fala + TTS da voz do aluno). Só o lado do
// ENTREVISTADOR (STT da fala do aluno, raciocínio, TTS do entrevistador) roda no
// SERVIDOR sob o work de benchmark → chave de benchmark. Assim o benchmark mede
// exatamente o que um aluno REAL gastaria.
//
// Uso (o servidor :5000 já deve estar no ar, na branch com is_benchmark):
//   node -r dotenv/config scripts/bench-interview-batch.mjs \
//     --items 01:bom \
//     [--run-id bench-...] [--template "Business Owner.yaml"] [--voice coral] \
//     [--questions 6] [--budget 20] [--base http://127.0.0.1:5000] [--headed] [--dry-run]
//
// --items: lista "NN:nivel" separada por vírgula (nivel ∈ fraco|medio|bom).
//          Ou "NN" sozinho = os três níveis. Ou "01-05" = faixa de pastas (3 níveis cada).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as db from "../lib/db.js";
import { pool } from "../auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const EXEMPLOS = "C:/Users/glads/Dropbox/Projetos/ORATIA/exemplos trabalhos";
const SCRATCH = path.join(process.env.TEMP || "C:/temp", "bench-worktext");

const PERSONA_BY_LEVEL = { bom: "dominante_generico", medio: "medio_generico", fraco: "fraco_generico" };
const LEVELS = ["fraco", "medio", "bom"];

// A PERSONA ENTREVISTADORA está explícita em cada enunciado (campo "Persona: X"),
// e X bate com o display.label de um dos 6 templates. Lemos do enunciado (fiel;
// nada de chutar). Chave normalizada (sem acento, minúscula) p/ robustez de encoding.
// Match por palavra-chave ASCII distintiva de cada persona — imune a mojibake de
// acento na extração do PDF (ex.: "Arguição acadêmica" pode sair "Argui??o acad?mica").
const PERSONA_MATCHERS = [
    { kw: "consultoria", tpl: "Business Owner.yaml" },   // Cliente de consultoria
    { kw: "sponsor", tpl: "Executive Sponsor.yaml" },    // Sponsor executivo
    { kw: "emprego", tpl: "Hiring Manager.yaml" },        // Entrevista de emprego
    { kw: "jornalista", tpl: "Journalist.yaml" },         // Jornalista
    { kw: "investidor", tpl: "Startup Investor.yaml" },   // Investidor
    { kw: "argui", tpl: "Teacher Assistant.yaml" },       // Arguição acadêmica
];
function normalizePersona(s) {
    // tira acentos decomponíveis E qualquer não-ascii remanescente (mojibake), minúscula.
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7f]/g, "").toLowerCase().trim();
}
// Extrai o campo "Persona:" do PDF do enunciado (pypdf) e resolve o template.
function templateForEnunciado(enunciadoPath) {
    const py = `from pypdf import PdfReader\nimport re,sys\nt="\\n".join((p.extract_text() or "") for p in PdfReader(r"${enunciadoPath}").pages)\nm=re.search(r"Persona:\\s*([^|\\n]+)",t)\nsys.stdout.write(m.group(1).strip() if m else "")`;
    const res = spawnSync("python", ["-c", py], { encoding: "utf-8" });
    if (res.status !== 0) throw new Error(`leitura da persona falhou: ${res.stderr || res.stdout}`);
    const label = String(res.stdout || "").trim();
    const key = normalizePersona(label);
    const hit = PERSONA_MATCHERS.find(m => key.includes(m.kw));
    if (!hit) throw new Error(`persona do enunciado não reconhecida: "${label}" (normalizada: "${key}")`);
    return { template: hit.tpl, personaLabel: label };
}

function parseArgs(argv) {
    // template null = lê a persona do enunciado; --template força um p/ todos.
    // driver: "direct" (sem browser, rápido) ou "browser" (Playwright, tempo real).
    const a = { items: null, runId: null, template: null, voice: "coral", questions: 5, budget: 20, base: "http://127.0.0.1:5000", driver: "direct", headed: false, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === "--items") a.items = argv[++i];
        else if (t === "--run-id") a.runId = argv[++i];
        else if (t === "--template") a.template = argv[++i];
        else if (t === "--voice") a.voice = argv[++i];
        else if (t === "--questions") a.questions = Number(argv[++i]);
        else if (t === "--budget") a.budget = Number(argv[++i]);
        else if (t === "--base") a.base = argv[++i];
        else if (t === "--driver") a.driver = argv[++i];
        else if (t === "--headed") a.headed = true;
        else if (t === "--dry-run") a.dryRun = true;
    }
    return a;
}

// "01:bom,02" | "01-03" → [{nn, level}]
function expandItems(spec) {
    const out = [];
    for (const part of String(spec).split(",").map(s => s.trim()).filter(Boolean)) {
        const range = part.match(/^(\d{2})-(\d{2})$/);
        if (range) {
            for (let n = Number(range[1]); n <= Number(range[2]); n++) for (const lv of LEVELS) out.push({ nn: String(n).padStart(2, "0"), level: lv });
            continue;
        }
        const [nn, level] = part.split(":");
        if (level) out.push({ nn: nn.padStart(2, "0"), level });
        else for (const lv of LEVELS) out.push({ nn: nn.padStart(2, "0"), level: lv });
    }
    return out;
}

function folderFor(nn) {
    const dirs = fs.readdirSync(EXEMPLOS).filter(d => d.startsWith(nn + " "));
    if (!dirs.length) throw new Error(`pasta do enunciado ${nn} não encontrada em ${EXEMPLOS}`);
    return path.join(EXEMPLOS, dirs[0]);
}

// Extrai o texto do PDF do aluno (pypdf) para ancorar o simulador (--work-text).
function extractStudentText(pdfPath, outTxt) {
    const py = `from pypdf import PdfReader\nimport sys\nr=PdfReader(r"${pdfPath}")\nopen(r"${outTxt}","w",encoding="utf-8").write("\\n".join((p.extract_text() or "") for p in r.pages))\nprint("ok")`;
    const res = spawnSync("python", ["-c", py], { encoding: "utf-8" });
    if (res.status !== 0) throw new Error(`extração de texto falhou: ${res.stderr || res.stdout}`);
    return outTxt;
}

async function configureBenchmarkWork({ nn, level, folder, template, voice, questions, budget, runId }) {
    const enunciadoPath = path.join(folder, "Enunciado do trabalho.pdf");
    if (!fs.existsSync(enunciadoPath)) throw new Error(`enunciado não encontrado: ${enunciadoPath}`);
    const templatePath = path.join(PROJECT_ROOT, "config", "interviewers", template);
    if (!fs.existsSync(templatePath)) throw new Error(`template do entrevistador não encontrado: ${templatePath}`);

    const name = `[BENCH] ${nn} ${level}`;
    const work = await db.createWork(name, budget, "interview", { isBenchmark: true, benchmarkRunId: runId });
    await db.setEnunciadoBlob(work.id, fs.readFileSync(enunciadoPath), "Enunciado do trabalho.pdf");
    await db.setInterviewerYaml(work.id, fs.readFileSync(templatePath, "utf-8"));
    await db.setQuestionCount(work.id, questions);
    await db.setInteractionMode(work.id, "audio", voice);
    return work;
}

function runHarness({ workToken, base, studentPdf, workTextFile, persona, headed, driver }) {
    // direct = tests/audio-e2e/direct.mjs (sem browser, POST do áudio no /chat, rápido);
    // browser = tests/audio-e2e/run.mjs (Playwright + microfone falso, tempo real).
    const script = driver === "browser" ? "tests/audio-e2e/run.mjs" : "tests/audio-e2e/direct.mjs";
    const args = [
        script,
        "--work", workToken,
        "--base", base,
        "--pdf", studentPdf,
        "--work-text", workTextFile,
        "--persona", persona,
    ];
    if (headed && driver === "browser") args.push("--headed");
    // stdio inherit: a saída do harness (progresso por turno) transmite ao vivo,
    // em vez de ficar em buffer até o fim. Facilita ver onde trava.
    const res = spawnSync("node", args, { cwd: PROJECT_ROOT, encoding: "utf-8", stdio: ["ignore", "inherit", "inherit"], env: process.env, timeout: 20 * 60 * 1000 });
    return { status: res.status, stdout: "", stderr: "" };
}

async function main() {
    const A = parseArgs(process.argv.slice(2));
    if (!A.items) throw new Error("--items obrigatório (ex.: --items 01:bom)");
    const runId = A.runId || `bench-${Date.now()}`;
    const items = expandItems(A.items);
    fs.mkdirSync(SCRATCH, { recursive: true });

    console.log(`=== Lote de benchmark de custo (áudio) ===`);
    console.log(`run_id=${runId} | driver=${A.driver} | voz=${A.voice} | perguntas=${A.questions} | budget=$${A.budget} | itens=${items.length}${A.dryRun ? " | DRY-RUN" : ""}`);

    const summary = [];
    for (const { nn, level } of items) {
        if (!PERSONA_BY_LEVEL[level]) { console.log(`! ${nn}:${level} nível inválido, pulando`); continue; }
        const folder = folderFor(nn);
        const studentPdf = path.join(folder, `Trabalho do aluno - ${level}.pdf`);
        if (!fs.existsSync(studentPdf)) { console.log(`! ${nn}:${level} PDF do aluno ausente, pulando`); continue; }

        // Persona entrevistadora vem do próprio enunciado (--template força um p/ todos).
        let template, personaLabel;
        if (A.template) { template = A.template; personaLabel = "(forçado por --template)"; }
        else { ({ template, personaLabel } = templateForEnunciado(path.join(folder, "Enunciado do trabalho.pdf"))); }
        console.log(`\n--- ${nn}:${level} (persona: ${personaLabel} → ${template.replace(".yaml", "")}) ---`);
        const work = await configureBenchmarkWork({ nn, level, folder, template, voice: A.voice, questions: A.questions, budget: A.budget, runId });
        console.log(`work=${work.work_token} (audio, ${A.questions}q) configurado`);

        const workTextFile = path.join(SCRATCH, `${nn}-${level}.txt`);
        extractStudentText(studentPdf, workTextFile);

        if (A.dryRun) { console.log(`(dry-run: harness não disparado)`); summary.push({ nn, level, work: work.work_token, status: "dry" }); continue; }

        const persona = PERSONA_BY_LEVEL[level];
        console.log(`rodando (${A.driver}, persona=${persona})…`);
        const t0 = Date.now();
        const r = runHarness({ workToken: work.work_token, base: A.base, studentPdf, workTextFile, persona, headed: A.headed, driver: A.driver });
        const secs = Math.round((Date.now() - t0) / 1000);
        const okLine = (r.stdout.match(/\[done\][^\n]*/) || r.stdout.match(/relat[óo]rio[^\n]*/) || [""])[0];
        console.log(`harness saiu status=${r.status} em ${secs}s ${okLine ? "| " + okLine : ""}`);
        if (r.status !== 0) console.log(`stderr(tail): ${r.stderr.slice(-500)}`);

        const bal = await db.getWorkByToken(work.work_token);
        console.log(`spent_usd(local calc)=$${Number(bal.spent_usd).toFixed(4)}`);
        summary.push({ nn, level, work: work.work_token, status: r.status, secs, spent: Number(bal.spent_usd) });
    }

    console.log(`\n=== Resumo do run ${runId} ===`);
    let total = 0;
    for (const s of summary) { total += s.spent || 0; console.log(`  ${s.nn}:${s.level} work=${s.work} status=${s.status}${s.secs ? ` ${s.secs}s` : ""}${s.spent != null ? ` $${s.spent.toFixed(4)}` : ""}`); }
    console.log(`  TOTAL calculado (local): $${total.toFixed(4)}`);
    console.log(`\nReconciliar depois: POST /api/cost-audit/run { "benchmark_run_id": "${runId}" }  (ou a página /cost-audit)`);
    await pool.end();
}

main().catch(err => { console.error("ERRO:", err.stack || err.message); process.exit(1); });

// CLI: cria um WORK DE BENCHMARK DE CUSTO.
//
// Um work marcado `is_benchmark=true` roteia TODAS as suas chamadas à OpenAI
// pela chave dedicada OPENAI_API_KEY_BENCHMARK (ver lib/openaiClient.js), para
// separar o gasto no painel da OpenAI e viabilizar a auditoria via Usage/Costs
// API (lib/costAudit.js). O `benchmark_run_id` agrupa vários works de um mesmo
// run de benchmark para reconciliar o custo em bloco.
//
// Uso:
//   node -r dotenv/config scripts/create-benchmark-work.mjs --from <workToken> [--run-id <id>] [--name <nome>] [--budget <usd>]
//   node -r dotenv/config scripts/create-benchmark-work.mjs --name "Bench texto" --kind interview [--run-id <id>] [--budget <usd>]
//
// --from <workToken>  Clona a configuração de um work existente (enunciado,
//                     entrevistador, modo/voz, perguntas da oral, rubrica, etc.),
//                     deixando o benchmark PRONTO para rodar como aquela entrevista.
// --run-id <id>       Agrupa works do mesmo run. Default: bench-<timestamp>.
// --name <nome>       Nome do work (default: "[BENCH] " + nome de origem, ou "Benchmark de custo").
// --kind <k>          interview | oral_realtime | scenario (default: kind da origem, ou interview).
// --budget <usd>      Orçamento do work (default: DEFAULT_WORK_BUDGET_USD).

import "dotenv/config";
import { pool } from "../auth.js";
import * as db from "../lib/db.js";
import { DEFAULT_WORK_BUDGET_USD } from "../lib/config.js";

function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === "--from") a.from = argv[++i];
        else if (t === "--run-id") a.runId = argv[++i];
        else if (t === "--name") a.name = argv[++i];
        else if (t === "--kind") a.kind = argv[++i];
        else if (t === "--budget") a.budget = argv[++i];
        else if (t === "--help" || t === "-h") a.help = true;
    }
    return a;
}

// Colunas de CONFIGURAÇÃO copiadas de um work de origem. Deliberadamente NÃO
// copia identidade/estado: work_token, name, kind, budget_usd, spent_usd,
// is_benchmark, benchmark_run_id, is_active, created_at.
const CONFIG_COLUMNS = [
    "enunciado_pdf", "enunciado_filename", "interviewer_yaml",
    "interaction_mode", "voice", "interviewer_name", "interviewer_gender",
    "question_count", "feedback_guidelines",
    "include_interviewer_opinion", "include_strengths", "include_improvement_areas", "include_study_suggestions",
    "grading_rubric", "grade_penalty_json", "expect_spontaneous",
    "proctoring_enabled", "devolutiva_proctor_prompt",
    "exam_pdf", "exam_filename", "oral_questions", "oral_grading_mode", "oral_next_qid",
    "oral_calibration_json",
];

async function copyConfig(dstId, srcId) {
    const setClause = CONFIG_COLUMNS.map((c) => `${c} = src.${c}`).join(",\n          ");
    await pool.query(
        `UPDATE works dst SET
          ${setClause},
          updated_at = now()
        FROM works src
        WHERE dst.id = $1 AND src.id = $2`,
        [dstId, srcId]
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log("Ver cabeçalho de scripts/create-benchmark-work.mjs para uso.");
        process.exit(0);
    }

    const runId = args.runId || `bench-${Date.now()}`;
    let budget = DEFAULT_WORK_BUDGET_USD;
    if (args.budget !== undefined) {
        const parsed = Number(args.budget);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error("--budget deve ser número >= 0");
        budget = parsed;
    }

    let source = null;
    if (args.from) {
        source = await db.getWorkByToken(String(args.from).toLowerCase());
        if (!source) throw new Error(`--from: work "${args.from}" não encontrado`);
    }

    const kind = args.kind || source?.kind || "interview";
    const name = args.name || (source ? `[BENCH] ${source.name}` : "Benchmark de custo");

    const work = await db.createWork(name, budget, kind, { isBenchmark: true, benchmarkRunId: runId });

    if (source) {
        await copyConfig(work.id, source.id);
        console.log(`Configuração clonada de "${source.name}" (${source.work_token}).`);
    }

    console.log("");
    console.log("Work de benchmark criado:");
    console.log(`  work_token       : ${work.work_token}`);
    console.log(`  name             : ${work.name}`);
    console.log(`  kind             : ${work.kind}`);
    console.log(`  budget_usd       : $${Number(work.budget_usd).toFixed(2)}`);
    console.log(`  is_benchmark     : ${work.is_benchmark}`);
    console.log(`  benchmark_run_id : ${work.benchmark_run_id}`);
    console.log("");
    console.log(`Painel do professor : /w/${work.work_token}`);
    console.log(`(As chamadas à OpenAI deste work usarão OPENAI_API_KEY_BENCHMARK.)`);

    await pool.end();
}

main().catch((err) => {
    console.error("ERRO:", err.message);
    process.exit(1);
});

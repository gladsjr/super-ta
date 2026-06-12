// Teste A/B do super-orquestrador: modelo FORTE (principal_reasoning_model) vs
// modelo RÁPIDO (fast_model), medindo se a qualidade das perguntas/follow-ups
// degrada, e quanto se economiza em custo e tempo. MODO TEXTO, auto-contido
// (PDFs sintéticos). Só precisa de OPENAI_API_KEY — sem servidor, sem Postgres.
//
// Desenho (ver README.md):
//  - Prep (analyzeWork + buildPlan) roda 1x no modelo FORTE e é compartilhada
//    pelos dois braços -> única variável = modelo do orquestrador.
//  - Para cada persona x repetição:
//      * braço FORTE conduz uma entrevista completa E, a cada turno, avalia o
//        modelo RÁPIDO no MESMO estado congelado (counterfactual pareado);
//      * braço RÁPIDO conduz uma entrevista completa independente.
//  - Juiz LLM (cego, ordem randomizada): pareado por turno + holístico por par.
//  - Reporta custo/latência por braço e os veredictos de qualidade.
//
// Uso:
//   node -r dotenv/config tests/ab-orchestrator/run.mjs
// Variáveis (todas opcionais):
//   AB_REPEATS (2)  AB_QUESTION_COUNT (6)  AB_MAX_STUDENT_TURNS (24)
//   AB_PERSONAS ("preparado,adversarial,fraco")
//   AB_PRINCIPAL_MODEL / AB_FAST_MODEL / AB_JUDGE_MODEL (default: policy.yaml)
//   AB_PRINCIPAL_EFFORT / AB_FAST_EFFORT (reasoning effort por braço; default
//     da API = medium = produção. Valores: minimal|low|medium|high)
//   AB_SKIP_JUDGE (set p/ pular o juiz)  AB_CONCURRENCY (1)

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPricing } from "../../lib/billing.js";
import { PRINCIPAL_REASONING_MODEL, FAST_MODEL } from "../../lib/config.js";
import { makeInstrumentedClient, summarizeSink } from "./instrument.mjs";
import { buildFixturePdfs, loadInterviewerYaml, PERSONAS } from "./fixtures.mjs";
import { buildSharedPrep } from "./prep.mjs";
import { runInterview } from "./driver.mjs";
import { judgeCounterfactualSample, judgeHolisticPair } from "./judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const usd = (x) => `$${Number(x).toFixed(4)}`;
const RECOMPUTE_RE = /(de quanto|quanto (cai|sobe|muda|fica|seria|passa|ganha|perde|tira)|qual (o |a )?(vpl|tir|valor)|recalcul|me d[áa] o n[úu]mero|valor exato|n[úu]mero exato|em quanto|chega a quanto|d[áa] quanto)/;

async function main() {
    loadPricing();

    const STRONG = env("AB_PRINCIPAL_MODEL", PRINCIPAL_REASONING_MODEL);
    const FAST = env("AB_FAST_MODEL", FAST_MODEL);
    const JUDGE = env("AB_JUDGE_MODEL", STRONG);
    // Reasoning effort por braço (opcional). Ausente = default da API (medium),
    // = comportamento de produção. Setar p/ testar low vs medium.
    const STRONG_EFFORT = env("AB_PRINCIPAL_EFFORT", null);
    const FAST_EFFORT = env("AB_FAST_EFFORT", null);
    const armLabel = (model, effort) => `${model} (effort=${effort || "default"})`;
    const QC = parseInt(env("AB_QUESTION_COUNT", "6"), 10);
    const REPEATS = parseInt(env("AB_REPEATS", "2"), 10);
    const MAXT = parseInt(env("AB_MAX_STUDENT_TURNS", "24"), 10);
    const personaKeys = env("AB_PERSONAS", "preparado,adversarial,fraco").split(",").map((s) => s.trim()).filter(Boolean);
    const skipJudge = !!process.env.AB_SKIP_JUDGE;

    for (const k of personaKeys) if (!PERSONAS[k]) throw new Error(`persona desconhecida: ${k} (válidas: ${Object.keys(PERSONAS).join(", ")})`);

    console.log("================ A/B super-orquestrador ================");
    console.log(`forte=${armLabel(STRONG, STRONG_EFFORT)}  rápido=${armLabel(FAST, FAST_EFFORT)}  juiz=${JUDGE}`);
    console.log(`personas=[${personaKeys.join(", ")}]  repetições=${REPEATS}  perguntas=${QC}  max_turns_aluno=${MAXT}`);
    console.log(`-> ${personaKeys.length * REPEATS} entrevistas por braço\n`);

    // Sinks de custo/latência por papel.
    const sinks = { prep: [], strongDriver: [], fastCounterfactual: [], fastIndependent: [], judge: [] };
    const prepClient = makeInstrumentedClient(sinks.prep);
    const strongDriverClient = makeInstrumentedClient(sinks.strongDriver);
    const fastCfClient = makeInstrumentedClient(sinks.fastCounterfactual);
    const fastIndepClient = makeInstrumentedClient(sinks.fastIndependent);
    const judgeClient = makeInstrumentedClient(sinks.judge);

    const interviewerYaml = loadInterviewerYaml();
    const { enunciadoBuf, trabalhoBuf } = buildFixturePdfs();

    // ---- Prep compartilhada (1x, modelo forte) ----
    const prep = await buildSharedPrep({ prepClient, prepModel: STRONG, enunciadoBuf, trabalhoBuf, interviewerYaml, questionCount: QC });
    console.log(`\n[plano] ${prep.plan.questions.length} perguntas geradas (compartilhadas pelos dois braços)\n`);

    // ---- Entrevistas ----
    const pairs = []; // { persona, repeat, strongRun, fastRun }
    for (const pk of personaKeys) {
        for (let r = 1; r <= REPEATS; r++) {
            const persona = PERSONAS[pk];
            console.log(`──── persona=${pk} rep=${r}/${REPEATS} ────`);

            console.log(`  [forte] conduzindo + counterfactual(rápido) por turno...`);
            const strongRun = await runInterview({
                label: `${pk}-r${r}-strong`, orchestratorModel: STRONG, orchestratorClient: strongDriverClient,
                orchestratorEffort: STRONG_EFFORT,
                studentModel: FAST, persona, interviewerYaml, analysis: prep.analysis, plan: prep.plan,
                vectorStoreId: prep.vectorStoreId, questionCount: QC, maxStudentTurns: MAXT,
                counterfactual: { model: FAST, client: fastCfClient, effort: FAST_EFFORT },
            });
            console.log(`    -> turnos=${strongRun.counts.interviewerTurns} asks=${strongRun.counts.asks} follow_ups=${strongRun.counts.followUps} fim=${strongRun.finalizeReason} flags_recalc=${strongRun.recomputeFlags.length}`);

            console.log(`  [rápido] conduzindo entrevista independente...`);
            const fastRun = await runInterview({
                label: `${pk}-r${r}-fast`, orchestratorModel: FAST, orchestratorClient: fastIndepClient,
                orchestratorEffort: FAST_EFFORT,
                studentModel: FAST, persona, interviewerYaml, analysis: prep.analysis, plan: prep.plan,
                vectorStoreId: prep.vectorStoreId, questionCount: QC, maxStudentTurns: MAXT,
                counterfactual: null,
            });
            console.log(`    -> turnos=${fastRun.counts.interviewerTurns} asks=${fastRun.counts.asks} follow_ups=${fastRun.counts.followUps} fim=${fastRun.finalizeReason} flags_recalc=${fastRun.recomputeFlags.length}\n`);

            pairs.push({ persona: pk, repeat: r, strongRun, fastRun });
        }
    }

    // ---- Juiz ----
    const cfJudgements = [];
    const holisticJudgements = [];
    if (!skipJudge) {
        const allCfSamples = pairs.flatMap((p) => p.strongRun.counterfactualSamples);
        console.log(`[juiz] pareado por turno: ${allCfSamples.length} amostras...`);
        for (const s of allCfSamples) {
            try { cfJudgements.push(await judgeCounterfactualSample(judgeClient, JUDGE, s)); }
            catch (err) { console.warn(`  juiz cf falhou (turno ${s.turnIndex}): ${err.message}`); }
        }
        console.log(`[juiz] holístico: ${pairs.length} pares...`);
        for (const p of pairs) {
            try { holisticJudgements.push(await judgeHolisticPair(judgeClient, JUDGE, p.strongRun, p.fastRun)); }
            catch (err) { console.warn(`  juiz holístico falhou (${p.persona} r${p.repeat}): ${err.message}`); }
        }
    } else {
        console.log("[juiz] pulado (AB_SKIP_JUDGE)");
    }

    // ---- Agregação ----
    const nInterviews = pairs.length;
    const cost = {
        prep: summarizeSink(sinks.prep),
        strongDriver: summarizeSink(sinks.strongDriver),
        fastIndependent: summarizeSink(sinks.fastIndependent),
        fastCounterfactual: summarizeSink(sinks.fastCounterfactual),
        judge: summarizeSink(sinks.judge),
    };
    const perInterview = {
        strong_usd: cost.strongDriver.total_cost_usd / nInterviews,
        fast_usd: cost.fastIndependent.total_cost_usd / nInterviews,
    };

    const cfTally = { strong: 0, fast: 0, tie: 0 };
    const cfDims = {};
    for (const j of cfJudgements) {
        cfTally[j.winner] = (cfTally[j.winner] || 0) + 1;
        for (const [d, w] of Object.entries(j.dims || {})) {
            cfDims[d] = cfDims[d] || { strong: 0, fast: 0, tie: 0 };
            cfDims[d][w] = (cfDims[d][w] || 0) + 1;
        }
    }
    // Aderência ao princípio "resposta de cabeça" no MESMO contexto (counterfactual).
    let cfRecompStrong = 0, cfRecompFast = 0, cfTotal = 0;
    for (const p of pairs) {
        for (const s of p.strongRun.counterfactualSamples) {
            cfTotal++;
            if (RECOMPUTE_RE.test(String(s.driverAction?.message || "").toLowerCase())) cfRecompStrong++;
            if (RECOMPUTE_RE.test(String(s.counterfactualAction?.message || "").toLowerCase())) cfRecompFast++;
        }
    }

    const holTally = { strong: 0, fast: 0, tie: 0 };
    const dimNames = ["relevancia", "follow_up_apropriado", "captura_contradicoes", "fidelidade_persona", "resposta_de_cabeca"];
    const holScore = { strong: {}, fast: {} };
    for (const d of dimNames) { holScore.strong[d] = []; holScore.fast[d] = []; }
    for (const j of holisticJudgements) {
        holTally[j.winner] = (holTally[j.winner] || 0) + 1;
        for (const arm of ["strong", "fast"]) {
            const sc = j.scores?.[arm] || {};
            for (const d of dimNames) if (typeof sc[d] === "number") holScore[arm][d].push(sc[d]);
        }
    }
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

    // Flags de recálculo somadas por braço (entrevistas independentes).
    const recompStrongRuns = pairs.reduce((n, p) => n + p.strongRun.recomputeFlags.length, 0);
    const recompFastRuns = pairs.reduce((n, p) => n + p.fastRun.recomputeFlags.length, 0);

    // ---- Saída ----
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(__dirname, "out", stamp);
    fs.mkdirSync(path.join(outDir, "transcripts"), { recursive: true });

    for (const p of pairs) {
        for (const [arm, run] of [["strong", p.strongRun], ["fast", p.fastRun]]) {
            const md = [
                `# ${p.persona} r${p.repeat} — ${arm} (${run.orchestratorModel})`,
                `fim=${run.finalizeReason} turnos_entrevistadora=${run.counts.interviewerTurns} asks=${run.counts.asks} follow_ups=${run.counts.followUps} flags_recalc=${run.recomputeFlags.length}`,
                "",
                ...run.transcript.map((h) => h.role === "interviewer"
                    ? `**Entrevistadora** ${h.kind ? `_[${h.kind}${h.follow_up_reason ? ":" + h.follow_up_reason : ""}]_ ` : ""}: ${h.text}`
                    : `**Aluno (${run.persona}):** ${h.text}`),
            ].join("\n\n");
            fs.writeFileSync(path.join(outDir, "transcripts", `${p.persona}-r${p.repeat}-${arm}.md`), md);
        }
    }

    const cfWinRate = (k) => (cfJudgements.length ? (100 * cfTally[k] / cfJudgements.length).toFixed(1) + "%" : "—");
    const holWinRate = (k) => (holisticJudgements.length ? (100 * holTally[k] / holisticJudgements.length).toFixed(1) + "%" : "—");

    const lines = [];
    lines.push(`# A/B super-orquestrador — ${stamp}`);
    lines.push("");
    lines.push(`- Braço baseline (forte): \`${armLabel(STRONG, STRONG_EFFORT)}\``);
    lines.push(`- Braço candidato (rápido): \`${armLabel(FAST, FAST_EFFORT)}\``);
    lines.push(`- Juiz: \`${JUDGE}\` (cego, ordem A/B randomizada)`);
    lines.push(`- ${nInterviews} entrevistas por braço (${personaKeys.length} personas × ${REPEATS} repetições), ${QC} perguntas no plano`);
    lines.push(`- Plano + análise gerados 1× no modelo forte e compartilhados (única variável = braço do orquestrador)`);
    lines.push("");
    lines.push(`## Custo por entrevista (conduzindo a conversa toda)`);
    lines.push("");
    lines.push(`| Braço | $/entrevista | total | latência/turno (p50 / p95) |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| forte (\`${armLabel(STRONG, STRONG_EFFORT)}\`) | ${usd(perInterview.strong_usd)} | ${usd(cost.strongDriver.total_cost_usd)} | ${cost.strongDriver.latency_ms.p50} / ${cost.strongDriver.latency_ms.p95} ms |`);
    lines.push(`| rápido (\`${armLabel(FAST, FAST_EFFORT)}\`) | ${usd(perInterview.fast_usd)} | ${usd(cost.fastIndependent.total_cost_usd)} | ${cost.fastIndependent.latency_ms.p50} / ${cost.fastIndependent.latency_ms.p95} ms |`);
    const savePct = perInterview.strong_usd > 0 ? (100 * (1 - perInterview.fast_usd / perInterview.strong_usd)).toFixed(1) : "—";
    const speedup = (cost.fastIndependent.latency_ms.p50 && cost.strongDriver.latency_ms.p50)
        ? (cost.strongDriver.latency_ms.p50 / cost.fastIndependent.latency_ms.p50).toFixed(2) + "×" : "—";
    lines.push("");
    lines.push(`**Economia do rápido: ~${savePct}% por entrevista. Speedup de latência (p50): ~${speedup}.**`);
    lines.push("");
    lines.push(`## Qualidade — pareado por turno (mesmo contexto congelado, ${cfJudgements.length} turnos julgados)`);
    lines.push("");
    lines.push(`Vitórias: **forte ${cfWinRate("strong")}** · **rápido ${cfWinRate("fast")}** · empate ${cfWinRate("tie")}`);
    lines.push("");
    lines.push(`Por dimensão (vitórias forte / rápido / empate):`);
    lines.push("");
    lines.push(`| Dimensão | forte | rápido | empate |`);
    lines.push(`|---|---|---|---|`);
    for (const [d, t] of Object.entries(cfDims)) lines.push(`| ${d} | ${t.strong || 0} | ${t.fast || 0} | ${t.tie || 0} |`);
    lines.push("");
    lines.push(`Aderência ao princípio "resposta de cabeça" no mesmo contexto: exigências de recálculo — forte ${cfRecompStrong}/${cfTotal}, rápido ${cfRecompFast}/${cfTotal} (menor é melhor).`);
    lines.push("");
    lines.push(`## Qualidade — holístico por entrevista (${holisticJudgements.length} pares julgados)`);
    lines.push("");
    lines.push(`Vitórias gerais: **forte ${holWinRate("strong")}** · **rápido ${holWinRate("fast")}** · empate ${holWinRate("tie")}`);
    lines.push("");
    lines.push(`Nota média por dimensão (1–5):`);
    lines.push("");
    lines.push(`| Dimensão | forte | rápido |`);
    lines.push(`|---|---|---|`);
    for (const d of dimNames) {
        const s = avg(holScore.strong[d]); const f = avg(holScore.fast[d]);
        lines.push(`| ${d} | ${s != null ? s.toFixed(2) : "—"} | ${f != null ? f.toFixed(2) : "—"} |`);
    }
    lines.push("");
    lines.push(`Flags de exigência de recálculo (heurística, entrevistas independentes): forte ${recompStrongRuns}, rápido ${recompFastRuns}.`);
    lines.push("");
    lines.push(`## Custos auxiliares (não comparativos)`);
    lines.push(`- prep (1×, forte): ${usd(cost.prep.total_cost_usd)}`);
    lines.push(`- counterfactual (rápido, ${cost.fastCounterfactual.calls} chamadas): ${usd(cost.fastCounterfactual.total_cost_usd)}`);
    lines.push(`- juiz: ${usd(cost.judge.total_cost_usd)}`);
    lines.push(`- **custo total do experimento: ${usd(cost.prep.total_cost_usd + cost.strongDriver.total_cost_usd + cost.fastIndependent.total_cost_usd + cost.fastCounterfactual.total_cost_usd + cost.judge.total_cost_usd)}**`);
    lines.push("");
    lines.push(`Transcrições completas em \`transcripts/\`. Dados crus em \`raw.json\`.`);

    const summary = lines.join("\n");
    fs.writeFileSync(path.join(outDir, "summary.md"), summary);
    fs.writeFileSync(path.join(outDir, "raw.json"), JSON.stringify({
        config: { STRONG, FAST, JUDGE, STRONG_EFFORT, FAST_EFFORT, QC, REPEATS, MAXT, personaKeys },
        cost, perInterview,
        counterfactual: { tally: cfTally, dims: cfDims, recompute: { strong: cfRecompStrong, fast: cfRecompFast, total: cfTotal }, judgements: cfJudgements },
        holistic: { tally: holTally, scores: holScore, judgements: holisticJudgements },
        pairs: pairs.map((p) => ({
            persona: p.persona, repeat: p.repeat,
            strong: { finalizeReason: p.strongRun.finalizeReason, counts: p.strongRun.counts, recompute: p.strongRun.recomputeFlags.length },
            fast: { finalizeReason: p.fastRun.finalizeReason, counts: p.fastRun.counts, recompute: p.fastRun.recomputeFlags.length },
        })),
    }, null, 2));

    console.log("\n" + summary);
    console.log(`\n[ok] saída em ${outDir}`);
}

main().catch((err) => { console.error("ERRO:", err.stack || err.message); process.exit(1); });

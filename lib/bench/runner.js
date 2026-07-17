import fs from "node:fs";
import path from "node:path";
import { loadPricing } from "../billing.js";
import { loadCaseSeeds, validateFrozenCases } from "./cases.js";
import { BenchmarkLedger } from "./ledger.js";
import { calculateMetrics } from "./metrics.js";
import { candidatePrompt, judgePrompt } from "./prompts.js";
import { markdownReport } from "./reports.js";
import { parseModelSpec, seededRandom, sha256 } from "./util.js";
import { createProviderAdapters } from "./adapters/index.js";
import { buildConsensus } from "./consensus.js";
import { evidenceText, retrieveEvidence } from "./rag.js";
import { assessAction, validateOrchestratorOutput } from "./orchestratorContract.js";
import { mapPool } from "../concurrency.js";

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function atomicWriteJson(file, value) {
    const temporary = `${file}.tmp`;
    writeJson(temporary, value);
    fs.renameSync(temporary, file);
}
function readCheckpoint(file, configHash) {
    if (!fs.existsSync(file)) return null;
    const checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));
    if (checkpoint.schema_version !== 1 || checkpoint.config_hash !== configHash) {
        throw new Error("checkpoint incompativel com a configuracao da execucao");
    }
    return checkpoint;
}
function outputKey(caseId, turnId, candidateKey) { return `${caseId}\u0000${turnId}\u0000${candidateKey}`; }
function judgmentKey(caseId, turnId, candidateKey, judgeKey) { return `${outputKey(caseId, turnId, candidateKey)}\u0000${judgeKey}`; }
function shuffled(items, random) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
        const target = Math.floor(random() * (index + 1));
        [copy[index], copy[target]] = [copy[target], copy[index]];
    }
    return copy;
}

function normalizedScore(parsed, candidatePosition) {
    let score = Number(parsed.score);
    if (!Number.isFinite(score) || score < -1 || score > 1) throw new Error(`score invalido do juiz: ${parsed.score}`);
    const winner = parsed.winner;
    const winnerScore = winner === "tie" ? 0 : winner === candidatePosition ? Math.abs(score) : -Math.abs(score);
    if (winner !== "A" && winner !== "B" && winner !== "tie") throw new Error(`winner invalido do juiz: ${winner}`);
    return winnerScore;
}

function validJudgment(value) {
    return value && ["A", "B", "tie"].includes(value.winner) && Number.isFinite(Number(value.score)) && value.dimensions && typeof value.dimensions === "object";
}

function makeRunKey() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runBenchmark(config, { dryRun = false, adapters = {}, onProgress = null, signal = null, casesOverride = null, resume = false } = {}) {
    loadPricing();
    const runKey = config.run_key || makeRunKey();
    const runDir = path.resolve(config.storage.runs_dir, runKey);
    ensureDir(runDir);
    ensureDir(path.join(runDir, "prompts"));
    ensureDir(path.join(runDir, "outputs"));
    ensureDir(path.join(runDir, "judgments"));
    ensureDir(path.join(runDir, "rag"));
    const cases = validateFrozenCases(casesOverride || loadCaseSeeds(path.resolve(config.cases_dir), config.case_ids || []));
    const candidates = config.candidates.map(parseModelSpec);
    const judges = config.judges.map(parseModelSpec);
    const providerAdapters = dryRun ? adapters : createProviderAdapters([...candidates, ...judges], config, adapters);

    const startedAtNow = new Date().toISOString();
    const resolved = { ...config, run_key: runKey, dry_run: dryRun };
    const configHash = sha256(resolved);
    const checkpointFile = path.join(runDir, "checkpoint.json");
    const checkpoint = resume && !dryRun ? readCheckpoint(checkpointFile, configHash) : null;
    const startedAt = checkpoint?.started_at || startedAtNow;
    writeJson(path.join(runDir, "config.resolved.json"), resolved);
    writeJson(path.join(runDir, "cases.json"), cases);
    const ledger = new BenchmarkLedger(runDir, Number(config.limits.max_cost_usd), {
        resume: Boolean(checkpoint), committedCount: checkpoint?.ledger_count,
    });
    const random = seededRandom(config.random_seed ?? 20260711);
    const outputs = checkpoint?.outputs || [];
    const judgments = checkpoint?.judgments || [];
    const outputsByKey = new Map(outputs.map((item) => [outputKey(item.case_id, item.turn_id, item.candidate_key), item]));
    const judgmentsByKey = new Map(judgments.map((item) => [judgmentKey(item.case_id, item.turn_id, item.candidate_key, item.judge_key), item]));
    let progressDone = Number(checkpoint?.progress_done || 0);
    const saveCheckpoint = (phase = "running") => {
        if (dryRun) return;
        atomicWriteJson(checkpointFile, {
            schema_version: 1, run_key: runKey, config_hash: configHash, phase,
            started_at: startedAt,
            progress_done: progressDone, ledger_count: ledger.entries.length,
            outputs, judgments, updated_at: new Date().toISOString(),
        });
    };
    const advance = async () => {
        progressDone++;
        if (onProgress) await onProgress(progressDone);
    };
    // Um erro em qualquer unidade aborta o lote: as unidades em voo terminam,
    // nenhuma nova começa, e o erro original é relançado (o checkpoint fica
    // consistente para retomada).
    let abortError = null;
    const assertActive = () => {
        if (signal?.aborted) throw Object.assign(new Error("execucao cancelada"), { code: "BENCH_CANCELLED" });
        if (abortError) throw abortError;
    };

    if (checkpoint && onProgress) await onProgress(progressDone);

    if (!dryRun) {
        // Plano determinístico: TODO o consumo do RNG (embaralhamento por turno
        // e posição A/B por julgamento) acontece aqui, sequencialmente, na MESMA
        // ordem do laço aninhado original — a concorrência da execução não pode
        // mudar a sequência de sorteios, senão resume/reprodutibilidade quebram.
        const units = [];
        for (const testCase of cases) {
            for (const turn of testCase.turns) {
                const evidence = retrieveEvidence(testCase, turn, config.rag || {});
                const sharedEvidenceText = evidenceText(evidence);
                writeJson(path.join(runDir, "rag", `${testCase.id}__${turn.id}.json`), evidence);
                const orderedCandidates = shuffled(candidates, random);
                for (const candidate of orderedCandidates) {
                    const judgePlan = judges.map((judge) => ({ judge, position: random() < 0.5 ? "A" : "B" }));
                    units.push({ testCase, turn, evidence, sharedEvidenceText, candidate, judgePlan });
                }
            }
        }

        const runUnit = async ({ testCase, turn, evidence, sharedEvidenceText, candidate, judgePlan }) => {
            assertActive();
            const currentOutputKey = outputKey(testCase.id, turn.id, candidate.key);
            let output = outputsByKey.get(currentOutputKey);
            if (!output) {
                        ledger.assertBudget();
                        const prompt = candidatePrompt(testCase, turn, sharedEvidenceText, config.prompts || {});
                        const candidateCall = await providerAdapters[candidate.provider].generateOrchestratorTurn({ spec: candidate, prompt });
                        const validation = validateOrchestratorOutput(candidateCall.parsed);
                        const structuredOutput = validation.normalized;
                        const actionAssessment = assessAction(structuredOutput, turn.canonical.policy);
                        const latencySamples = [candidateCall.latency_ms];
                        const repetitions = Math.max(1, Math.min(5, Number(config.limits?.latency_repetitions || 1)));
                        for (let repetition = 1; repetition < repetitions; repetition++) {
                            assertActive(); ledger.assertBudget();
                            const repeatedCall = await providerAdapters[candidate.provider].generateOrchestratorTurn({ spec: candidate, prompt });
                            latencySamples.push(repeatedCall.latency_ms);
                            ledger.record({ provider: candidate.provider, model: candidate.model, effort: candidate.effort, role: "candidate_latency_repeat", case_id: testCase.id, turn_id: turn.id, request: repeatedCall.request, response: repeatedCall.response, usage: repeatedCall.usage, latency_ms: repeatedCall.latency_ms, cost_estimated_usd: repeatedCall.cost.cost_usd, cost_source: repeatedCall.cost.cost_source || "estimated" });
                            await advance();
                        }
                        output = {
                            case_id: testCase.id, turn_id: turn.id, candidate_key: candidate.key,
                            text: structuredOutput.action.message, output: structuredOutput,
                            schema_valid: validation.valid, validation_errors: validation.errors,
                            action_assessment: actionAssessment,
                            usage: candidateCall.usage, latency_ms: candidateCall.latency_ms,
                            latency_samples_ms: latencySamples, actionable_latency_ms: candidateCall.actionable_latency_ms ?? null,
                            cost_estimated_usd: candidateCall.cost.cost_usd,
                            cost_source: candidateCall.cost.cost_source || "estimated",
                            evidence_package_hash: evidence.package_hash,
                        };
                        outputs.push(output);
                        outputsByKey.set(currentOutputKey, output);
                        ledger.record({ provider: candidate.provider, model: candidate.model, effort: candidate.effort, role: "candidate", case_id: testCase.id, turn_id: turn.id, request: candidateCall.request, response: candidateCall.response, usage: candidateCall.usage, latency_ms: candidateCall.latency_ms, cost_estimated_usd: candidateCall.cost.cost_usd, cost_source: candidateCall.cost.cost_source || "estimated" });
                        fs.writeFileSync(path.join(runDir, "prompts", `${testCase.id}__${turn.id}__${sha256(candidate.key).slice(0, 8)}.txt`), prompt, "utf8");
                        await advance();
                        saveCheckpoint();
                    }

                    for (const { judge, position: candidatePosition } of judgePlan) {
                        const currentJudgmentKey = judgmentKey(testCase.id, turn.id, candidate.key, judge.key);
                        if (judgmentsByKey.has(currentJudgmentKey)) continue;
                        assertActive();
                        ledger.assertBudget();
                        const pair = candidatePosition === "A" ? { A: output.output, B: turn.canonical.output } : { A: turn.canonical.output, B: output.output };
                        const promptForJudge = judgePrompt(testCase, turn, pair, sharedEvidenceText, config.prompts || {});
                        let judgeCall;
                        const attempts = 1 + Math.max(0, Math.min(2, Number(config.limits?.retries || 0)));
                        for (let attempt = 0; attempt < attempts; attempt++) {
                            assertActive(); ledger.assertBudget();
                            judgeCall = await providerAdapters[judge.provider].judgePair({ spec: judge, prompt: promptForJudge });
                            ledger.record({ provider: judge.provider, model: judge.model, effort: judge.effort, role: attempt ? "judge_retry" : "judge", case_id: testCase.id, turn_id: turn.id, candidate_key: candidate.key, request: judgeCall.request, response: judgeCall.response, usage: judgeCall.usage, latency_ms: judgeCall.latency_ms, cost_estimated_usd: judgeCall.cost.cost_usd, cost_source: judgeCall.cost.cost_source || "estimated" });
                            await advance();
                            if (validJudgment(judgeCall.parsed)) break;
                        }
                        if (!validJudgment(judgeCall?.parsed)) throw new Error(`juiz ${judge.key} retornou julgamento estruturado invalido`);
                        const score = normalizedScore(judgeCall.parsed, candidatePosition);
                        const dimensions = Object.fromEntries(Object.entries(judgeCall.parsed.dimensions || {}).map(([key, value]) => [key, candidatePosition === "A" ? Number(value) : -Number(value)]));
                        const judgment = {
                            case_id: testCase.id, turn_id: turn.id, area: testCase.area, large_area: testCase.large_area,
                            persona: testCase.interviewer_persona.key, candidate_key: candidate.key, judge_key: judge.key,
                            candidate_position: candidatePosition, score, dimensions,
                            confidence: Number(judgeCall.parsed.confidence || 0), critical_failure: Boolean(judgeCall.parsed.critical_failure),
                            rationale: judgeCall.parsed.rationale || "", candidate_cost_usd: output.cost_estimated_usd,
                            judge_cost_usd: judgeCall.cost.cost_usd, candidate_latency_ms: output.latency_ms,
                            actionable_latency_ms: output.actionable_latency_ms, action_assessment: output.action_assessment,
                            evidence_package_hash: evidence.package_hash,
                        };
                        judgments.push(judgment);
                        judgmentsByKey.set(currentJudgmentKey, judgment);
                        saveCheckpoint();
                    }
        };

        // O gargalo é a chamada dos modelos; unidades (caso×turno×candidato)
        // são independentes entre si — roda até max_concurrency em voo.
        const concurrency = Math.max(1, Math.floor(Number(config.limits?.max_concurrency)) || 1);
        await mapPool(units, concurrency, async (unit) => {
            if (abortError) return;
            try { await runUnit(unit); }
            catch (err) { if (!abortError) abortError = err; }
        });
        if (abortError) throw abortError;
    }

    const finishedAt = new Date().toISOString();
    const run = { benchmark: config.benchmark, run_key: runKey, setup_version: config.setup_version, context_version: config.context_version, jury_version: config.jury_version, mode: config.mode, started_at: startedAt, finished_at: finishedAt, status: dryRun ? "validated" : "completed", cases: cases.length, turns: cases.reduce((sum, item) => sum + item.turns.length, 0), candidates: candidates.map((item) => item.key), judges: judges.map((item) => item.key) };
    const consensus = buildConsensus(judgments, config.consensus || {});
    const metrics = calculateMetrics(consensus.length ? consensus : judgments, ledger.entries);
    writeJson(path.join(runDir, "manifest.json"), { ...run, config_hash: configHash, cases_hash: sha256(cases) });
    writeJson(path.join(runDir, "outputs", "all.json"), outputs);
    writeJson(path.join(runDir, "judgments", "all.json"), judgments);
    writeJson(path.join(runDir, "judgments", "consensus.json"), consensus);
    writeJson(path.join(runDir, "metrics.json"), metrics);
    writeJson(path.join(runDir, "raw.json"), { run, outputs, judgments, consensus, ledger: ledger.entries });
    fs.writeFileSync(path.join(runDir, "summary.md"), markdownReport(run, metrics), "utf8");
    saveCheckpoint("computed");
    return { run, metrics, runDir };
}

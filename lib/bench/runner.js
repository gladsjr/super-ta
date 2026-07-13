import fs from "node:fs";
import path from "node:path";
import { loadPricing } from "../billing.js";
import { loadCases } from "./cases.js";
import { BenchmarkLedger } from "./ledger.js";
import { calculateMetrics } from "./metrics.js";
import { candidatePrompt, judgePrompt } from "./prompts.js";
import { markdownReport } from "./reports.js";
import { parseModelSpec, seededRandom, sha256 } from "./util.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { XaiAdapter } from "./adapters/xai.js";
import { buildConsensus } from "./consensus.js";
import { evidenceText, retrieveEvidence } from "./rag.js";

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function normalizedScore(parsed, candidatePosition) {
    let score = Number(parsed.score);
    if (!Number.isFinite(score) || score < -1 || score > 1) throw new Error(`score invalido do juiz: ${parsed.score}`);
    const winner = parsed.winner;
    const winnerScore = winner === "tie" ? 0 : winner === candidatePosition ? Math.abs(score) : -Math.abs(score);
    if (winner !== "A" && winner !== "B" && winner !== "tie") throw new Error(`winner invalido do juiz: ${winner}`);
    return winnerScore;
}

function makeRunKey() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runBenchmark(config, { dryRun = false, adapters = {}, onProgress = null, signal = null, casesOverride = null } = {}) {
    loadPricing();
    const runKey = config.run_key || makeRunKey();
    const runDir = path.resolve(config.storage.runs_dir, runKey);
    ensureDir(runDir);
    ensureDir(path.join(runDir, "prompts"));
    ensureDir(path.join(runDir, "outputs"));
    ensureDir(path.join(runDir, "judgments"));
    ensureDir(path.join(runDir, "rag"));
    const cases = casesOverride || loadCases(path.resolve(config.cases_dir), config.case_ids || []);
    const candidates = config.candidates.map(parseModelSpec);
    const judges = config.judges.map(parseModelSpec);
    const providerAdapters = { ...adapters };
    const requiredProviders = new Set([...candidates, ...judges].map((spec) => spec.provider));
    if (!dryRun) {
        const options = { timeoutMs: config.limits.timeout_ms, retries: config.limits.retries };
        if (requiredProviders.has("openai") && !providerAdapters.openai) providerAdapters.openai = new OpenAIAdapter(options);
        if (requiredProviders.has("anthropic") && !providerAdapters.anthropic) providerAdapters.anthropic = new AnthropicAdapter({ ...options, pricing: config.providers?.anthropic?.pricing });
        if (requiredProviders.has("gemini") && !providerAdapters.gemini) providerAdapters.gemini = new GeminiAdapter({ ...options, pricing: config.providers?.gemini?.pricing });
        if (requiredProviders.has("xai") && !providerAdapters.xai) providerAdapters.xai = new XaiAdapter(options);
    }
    const supportedProviders = new Set(["openai", "anthropic", "gemini", "xai", ...Object.keys(providerAdapters)]);
    for (const spec of [...candidates, ...judges]) if (!supportedProviders.has(spec.provider)) throw new Error(`fornecedor nao configurado: ${spec.provider}`);

    const startedAt = new Date().toISOString();
    const resolved = { ...config, run_key: runKey, dry_run: dryRun };
    writeJson(path.join(runDir, "config.resolved.json"), resolved);
    writeJson(path.join(runDir, "cases.json"), cases);
    const ledger = new BenchmarkLedger(runDir, Number(config.limits.max_cost_usd));
    const random = seededRandom(config.random_seed ?? 20260711);
    const outputs = [];
    const judgments = [];
    let progressDone = 0;
    const advance = async () => {
        progressDone++;
        if (onProgress) await onProgress(progressDone);
    };
    const assertActive = () => {
        if (signal?.aborted) throw Object.assign(new Error("execucao cancelada"), { code: "BENCH_CANCELLED" });
    };

    if (!dryRun) {
        for (const testCase of cases) {
            for (const turn of testCase.turns) {
                const evidence = retrieveEvidence(testCase, turn, config.rag || {});
                const sharedEvidenceText = evidenceText(evidence);
                writeJson(path.join(runDir, "rag", `${testCase.id}__${turn.id}.json`), evidence);
                for (const candidate of candidates) {
                    assertActive();
                    ledger.assertBudget();
                    const prompt = candidatePrompt(testCase, turn, sharedEvidenceText, config.prompts || {});
                    const candidateCall = await providerAdapters[candidate.provider].generateInterviewTurn({ spec: candidate, prompt });
                    const output = {
                        case_id: testCase.id, turn_id: turn.id, candidate_key: candidate.key,
                        text: candidateCall.text, usage: candidateCall.usage, latency_ms: candidateCall.latency_ms,
                        cost_estimated_usd: candidateCall.cost.cost_usd,
                        cost_source: candidateCall.cost.cost_source || "estimated",
                        evidence_package_hash: evidence.package_hash,
                    };
                    outputs.push(output);
                    ledger.record({ provider: candidate.provider, model: candidate.model, effort: candidate.effort, role: "candidate", case_id: testCase.id, turn_id: turn.id, request: candidateCall.request, response: candidateCall.response, usage: candidateCall.usage, latency_ms: candidateCall.latency_ms, cost_estimated_usd: candidateCall.cost.cost_usd, cost_source: candidateCall.cost.cost_source || "estimated" });
                    fs.writeFileSync(path.join(runDir, "prompts", `${testCase.id}__${turn.id}__${sha256(candidate.key).slice(0, 8)}.txt`), prompt, "utf8");
                    await advance();

                    for (const judge of judges) {
                        assertActive();
                        ledger.assertBudget();
                        const candidatePosition = random() < 0.5 ? "A" : "B";
                        const pair = candidatePosition === "A" ? { A: output.text, B: turn.canonical_response } : { A: turn.canonical_response, B: output.text };
                        const promptForJudge = judgePrompt(testCase, turn, pair, sharedEvidenceText, config.prompts || {});
                        const judgeCall = await providerAdapters[judge.provider].judgePair({ spec: judge, prompt: promptForJudge });
                        const score = normalizedScore(judgeCall.parsed, candidatePosition);
                        const dimensions = Object.fromEntries(Object.entries(judgeCall.parsed.dimensions || {}).map(([key, value]) => [key, candidatePosition === "A" ? Number(value) : -Number(value)]));
                        const judgment = {
                            case_id: testCase.id, turn_id: turn.id, area: testCase.area, large_area: testCase.large_area,
                            persona: testCase.persona.key, candidate_key: candidate.key, judge_key: judge.key,
                            candidate_position: candidatePosition, score, dimensions,
                            confidence: Number(judgeCall.parsed.confidence || 0), critical_failure: Boolean(judgeCall.parsed.critical_failure),
                            rationale: judgeCall.parsed.rationale || "", candidate_cost_usd: candidateCall.cost.cost_usd,
                            judge_cost_usd: judgeCall.cost.cost_usd, candidate_latency_ms: candidateCall.latency_ms,
                            evidence_package_hash: evidence.package_hash,
                        };
                        judgments.push(judgment);
                        ledger.record({ provider: judge.provider, model: judge.model, effort: judge.effort, role: "judge", case_id: testCase.id, turn_id: turn.id, candidate_key: candidate.key, request: judgeCall.request, response: judgeCall.response, usage: judgeCall.usage, latency_ms: judgeCall.latency_ms, cost_estimated_usd: judgeCall.cost.cost_usd, cost_source: judgeCall.cost.cost_source || "estimated" });
                        await advance();
                    }
                }
            }
        }
    }

    const finishedAt = new Date().toISOString();
    const run = { benchmark: config.benchmark, run_key: runKey, setup_version: config.setup_version, context_version: config.context_version, jury_version: config.jury_version, mode: config.mode, started_at: startedAt, finished_at: finishedAt, status: dryRun ? "validated" : "completed", cases: cases.length, turns: cases.reduce((sum, item) => sum + item.turns.length, 0), candidates: candidates.map((item) => item.key), judges: judges.map((item) => item.key) };
    const consensus = buildConsensus(judgments, config.consensus || {});
    const metrics = calculateMetrics(consensus.length ? consensus : judgments, ledger.entries);
    writeJson(path.join(runDir, "manifest.json"), { ...run, config_hash: sha256(resolved), cases_hash: sha256(cases) });
    writeJson(path.join(runDir, "outputs", "all.json"), outputs);
    writeJson(path.join(runDir, "judgments", "all.json"), judgments);
    writeJson(path.join(runDir, "judgments", "consensus.json"), consensus);
    writeJson(path.join(runDir, "metrics.json"), metrics);
    writeJson(path.join(runDir, "raw.json"), { run, outputs, judgments, consensus, ledger: ledger.entries });
    fs.writeFileSync(path.join(runDir, "summary.md"), markdownReport(run, metrics), "utf8");
    return { run, metrics, runDir };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCaseSeeds, validateFrozenCases } from "../lib/bench/cases.js";
import { runBenchmark } from "../lib/bench/runner.js";
import { buildConsensus } from "../lib/bench/consensus.js";
import { buildReleaseComparison } from "../lib/bench/comparison.js";
import { retrieveEvidence } from "../lib/bench/rag.js";
import { clusterBootstrapMean, twoSidedSignTest } from "../lib/bench/statistics.js";
import { assessAction, validateOrchestratorOutput } from "../lib/bench/orchestratorContract.js";
import { generateCanonicalSetup } from "../lib/bench/setupGenerator.js";
import { jsonb } from "../lib/bench/store.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function output(kind = "follow_up") {
    return {
        action: {
            kind, message: "Pode explicar melhor esse ponto?", plan_question_id: kind === "ask" ? "q2" : null, revisit_topic: null,
            objectives: [], concerns: [], decision_criteria: [], information_needs: [], evaluation_mode: [],
            about_turn_index: kind === "follow_up" ? 0 : null,
            follow_up_reason: kind === "follow_up" ? "incomplete" : null,
            hint: null, finalize_reason: kind === "finalize" ? "plan_exhausted" : null,
        },
        rationale: "A resposta ainda nao cobre o objetivo planejado.",
        memory: { questions_covered: [], questions_skipped: [], open_threads: ["ponto pendente"], free_notes: "" },
    };
}

function freeze(seed) {
    return {
        ...seed,
        turns: seed.student_states.map((state, index) => ({
            id: state.id, objective_id: state.objective_id, responds_to: state.responds_to,
            history: index ? [{ role: "interviewer", text: seed.interview_plan.opening_question }, { role: "student", text: "Resposta anterior" }] : [{ role: "interviewer", text: seed.interview_plan.opening_question }],
            student_message: state.response_guidance, memory_before: output().memory,
            input_metadata: state.input_metadata || { channel: "text", transcript_confidence: 1 },
            canonical: {
                output: output(state.expected_action_kinds[0]),
                policy: { preferred_kind: state.expected_action_kinds[0], acceptable_kinds: state.expected_action_kinds, forbidden_kinds: [], required_action_fields: state.required_action_fields || {} },
                expected_intents: state.expected_intents || [], known_risks: state.known_risks || [],
            },
        })),
    };
}

test("carrega e valida os cinco casos seed", () => {
    const cases = loadCaseSeeds(path.join(projectRoot, "bench", "cases"));
    assert.equal(cases.length, 5);
    assert.equal(cases.reduce((sum, item) => sum + item.student_states.length, 0), 32);
    assert.ok(cases.every((item) => item.supporting_documents === undefined));
    assert.ok(cases.every((item) => /^[a-f0-9]{64}$/.test(item.source_hash)));
});

test("run dry-run produz pacote reproduzivel sem chamadas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-bench-"));
    const frozen = freeze(loadCaseSeeds(path.join(projectRoot, "bench", "cases"), ["eco-inflacao-juros"])[0]);
    const result = await runBenchmark({
        benchmark: "ORATIA-Bench", setup_version: "S0", context_version: "C0", jury_version: "J0",
        mode: "frozen-turn", cases_dir: path.join(projectRoot, "bench", "cases"), case_ids: ["eco-inflacao-juros"],
        candidates: ["openai:gpt-5.6-luna:medium"], judges: ["openai:gpt-5.6-sol:high"],
        storage: { runs_dir: dir }, limits: { max_cost_usd: 1, latency_repetitions: 1 },
    }, { dryRun: true, casesOverride: [frozen] });
    assert.equal(result.run.status, "validated");
    assert.equal(result.run.turns, 6);
    for (const file of ["manifest.json", "config.resolved.json", "cases.json", "ledger.jsonl", "metrics.json", "summary.md", "raw.json"]) {
        assert.ok(fs.existsSync(path.join(result.runDir, file)), file);
    }
    assert.equal(fs.readFileSync(path.join(result.runDir, "ledger.jsonl"), "utf8"), "");
});

test("serializa arrays explicitamente para colunas jsonb", () => {
    assert.equal(jsonb([], []), "[]");
    assert.deepEqual(JSON.parse(jsonb(["schema invalido"], [])), ["schema invalido"]);
});

test("retoma do ultimo checkpoint sem repetir unidades concluidas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-bench-resume-"));
    const frozen = freeze(loadCaseSeeds(path.join(projectRoot, "bench", "cases"), ["eco-inflacao-juros"])[0]);
    frozen.turns = frozen.turns.slice(0, 2);
    let candidateCalls = 0;
    let judgeCalls = 0;
    let interrupt = true;
    const fake = {
        async generateOrchestratorTurn() {
            candidateCalls += 1;
            if (interrupt && candidateCalls === 2) throw new Error("queda simulada");
            return { parsed: output(), text: JSON.stringify(output()), request: {}, response: {}, usage: {}, latency_ms: 12, cost: { cost_usd: 0.01 } };
        },
        async judgePair() {
            judgeCalls += 1;
            return { parsed: { winner: "tie", score: 0, dimensions: { decision_quality: 0 }, confidence: 0.9, critical_failure: false, rationale: "equivalentes" }, request: {}, response: {}, usage: {}, latency_ms: 20, cost: { cost_usd: 0.02 } };
        },
    };
    const config = {
        benchmark: "ORATIA-Bench", run_key: "resume-test", setup_version: "S0", context_version: "C0", jury_version: "J0", mode: "frozen-turn",
        random_seed: 20260711, cases_dir: path.join(projectRoot, "bench", "cases"), case_ids: ["eco-inflacao-juros"],
        candidates: ["fake:model:medium"], judges: ["fake:judge:high"], storage: { runs_dir: dir }, limits: { max_cost_usd: 2, latency_repetitions: 1 },
    };

    await assert.rejects(() => runBenchmark(config, { adapters: { fake }, casesOverride: [frozen] }), /queda simulada/);
    const partial = JSON.parse(fs.readFileSync(path.join(dir, "resume-test", "checkpoint.json"), "utf8"));
    assert.equal(partial.outputs.length, 1);
    assert.equal(partial.judgments.length, 1);
    assert.equal(partial.progress_done, 2);

    interrupt = false;
    await runBenchmark(config, { adapters: { fake }, casesOverride: [frozen], resume: true });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "resume-test", "raw.json"), "utf8"));
    const completed = JSON.parse(fs.readFileSync(path.join(dir, "resume-test", "checkpoint.json"), "utf8"));
    assert.equal(raw.outputs.length, 2);
    assert.equal(raw.judgments.length, 2);
    assert.equal(raw.ledger.length, 4);
    assert.equal(candidateCalls, 3);
    assert.equal(judgeCalls, 2);
    assert.equal(completed.phase, "computed");
});

test("normaliza julgamento de acordo com a posicao randomizada", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-bench-"));
    const fake = {
        async generateOrchestratorTurn() {
            return { parsed: output(), text: JSON.stringify(output()), request: {}, response: {}, usage: {}, latency_ms: 12, cost: { cost_usd: 0.01 } };
        },
        async judgePair() {
            return { parsed: { winner: "A", score: 0.7, dimensions: { decision_quality: 0.5 }, confidence: 0.9, critical_failure: false, rationale: "A foi melhor" }, request: {}, response: {}, usage: {}, latency_ms: 20, cost: { cost_usd: 0.02 } };
        },
    };
    const result = await runBenchmark({
            benchmark: "ORATIA-Bench", setup_version: "S0", context_version: "C0", jury_version: "J0", mode: "frozen-turn",
            random_seed: 20260711,
            cases_dir: path.join(projectRoot, "bench", "cases"), case_ids: ["eco-inflacao-juros"],
            candidates: ["fake:model:medium"], judges: ["fake:judge:high"], storage: { runs_dir: dir }, limits: { max_cost_usd: 2, latency_repetitions: 1 },
        }, { adapters: { fake }, casesOverride: [freeze(loadCaseSeeds(path.join(projectRoot, "bench", "cases"), ["eco-inflacao-juros"])[0])] });
        const raw = JSON.parse(fs.readFileSync(path.join(result.runDir, "raw.json"), "utf8"));
        const first = raw.judgments[0];
        const direction = first.candidate_position === "A" ? 1 : -1;
        assert.equal(first.score, direction * 0.7);
        assert.equal(first.dimensions.decision_quality, direction * 0.5);
        assert.ok(Math.abs(result.metrics.models["fake:model:medium"].overall.cost.candidate_usd - 0.06) < 1e-9);
});

test("conselho usa mediana e sinaliza discordancia", () => {
    const base = { case_id: "c1", turn_id: "t1", area: "A", large_area: "G", persona: "p", candidate_key: "modelo", confidence: 0.9, critical_failure: false };
    const result = buildConsensus([
        { ...base, judge_key: "j1", score: -0.8, dimensions: { relevance: -0.7 } },
        { ...base, judge_key: "j2", score: 0.1, dimensions: { relevance: 0.2 } },
        { ...base, judge_key: "j3", score: 0.7, dimensions: { relevance: 0.6 } },
    ], { disagreement_threshold: 0.65 });
    assert.equal(result.length, 1);
    assert.equal(result[0].score, 0.1);
    assert.equal(result[0].dimensions.relevance, 0.2);
    assert.equal(result[0].needs_deliberation, true);
    assert.deepEqual(result[0].agreement, { score_stddev: result[0].agreement.score_stddev, score_spread: 1.5, positive: 1, neutral: 1, negative: 1 });
});

test("RAG entrega o mesmo pacote deterministico para um estado congelado", () => {
    const testCase = freeze(loadCaseSeeds(path.join(projectRoot, "bench", "cases"), ["adm-restaurante-energia"])[0]);
    const first = retrieveEvidence(testCase, testCase.turns[1], { chunk_chars: 120, top_k: 20 });
    const second = retrieveEvidence(testCase, testCase.turns[1], { chunk_chars: 120, top_k: 20 });
    assert.equal(first.package_hash, second.package_hash);
    assert.deepEqual(first.chunks.map((item) => item.id), second.chunks.map((item) => item.id));
    assert.ok(first.chunks.some((item) => item.content.includes("14%")));
    assert.ok(first.chunks.every((item) => ["assignment", "student_work"].includes(item.source)));
});

test("contrato distingue validade estrutural e adequacao da decisao", () => {
    const valid = validateOrchestratorOutput(output());
    assert.equal(valid.valid, true);
    const accepted = assessAction(valid.normalized, { preferred_kind: "follow_up", acceptable_kinds: ["follow_up", "ask"], forbidden_kinds: ["finalize"] });
    assert.equal(accepted.preferred, true);
    assert.equal(accepted.acceptable, true);
    const forbidden = assessAction(output("finalize"), { preferred_kind: "follow_up", acceptable_kinds: ["follow_up"], forbidden_kinds: ["finalize"] });
    assert.equal(forbidden.schema_valid, true);
    assert.equal(forbidden.forbidden, true);
    assert.equal(forbidden.critical_failure, true);
    assert.doesNotThrow(() => validateFrozenCases([freeze(loadCaseSeeds(path.join(projectRoot, "bench", "cases"), ["adm-restaurante-energia"])[0])]));
});

test("geracao por conselho congela falas, propostas, votos e politica", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-setup-"));
    const seed = loadCaseSeeds(path.join(projectRoot, "bench", "cases"), ["adm-restaurante-energia"])[0];
    seed.student_states = seed.student_states.slice(0, 2);
    let studentIndex = 0;
    let proposalIndex = 0;
    let proposalKind = "follow_up";
    const fake = {
        async generateStudentReply() {
            studentIndex += 1;
            return { parsed: { message: `Resposta simulada ${studentIndex}`, behavior_observed: "comportamento preservado" }, request: { type: "student" }, response: {}, usage: {}, latency_ms: 10, cost: { cost_usd: 0.01, cost_source: "estimated" } };
        },
        async generateSetupProposal({ prompt }) {
            proposalIndex += 1;
            proposalKind = prompt.includes('"ask"') ? "ask" : "follow_up";
            const parsed = output(proposalKind);
            if (proposalIndex === 1) parsed.rationale = "";
            return { parsed, request: { type: "proposal", prompt }, response: {}, usage: {}, latency_ms: 12, cost: { cost_usd: 0.02, cost_source: "estimated" } };
        },
        async voteSetup() {
            return { parsed: { selected_proposal_id: "P1", acceptable_proposal_ids: ["P1"], acceptable_kinds: [proposalKind], forbidden_kinds: ["finalize"], confidence: 0.9, rationale: "proposta adequada" }, request: { type: "vote" }, response: {}, usage: {}, latency_ms: 8, cost: { cost_usd: 0.01, cost_source: "estimated" } };
        },
    };
    const result = await generateCanonicalSetup({
        key: "setup-test", cases: [seed], council: ["fake:wise:high"], artifactDir,
        adapters: { fake }, config: { limits: { max_cost_usd: 5, retries: 1 }, rag: { top_k: 3 }, prompts: {}, providers: {} },
    });
    assert.equal(result.cases[0].turns.length, 2);
    assert.equal(result.calls.length, 7);
    assert.match(result.calls.find((call) => call.role === "setup_proposal_retry").request.prompt, /rationale.*obrigat/i);
    assert.equal(result.cases[0].turns[0].canonical.policy.preferred_kind, "follow_up");
    assert.deepEqual(result.cases[0].turns[0].canonical.policy.forbidden_kinds, ["finalize"]);
    assert.equal(result.cases[0].turns[1].history.at(-1).role, "interviewer");
    assert.ok(fs.existsSync(path.join(artifactDir, "manifest.generated.json")));
    assert.doesNotThrow(() => validateFrozenCases(result.cases));
});

test("estatistica usa bootstrap por caso e teste de sinais", () => {
    const items = [
        { case_id: "a", score: 0.8 }, { case_id: "a", score: 0.6 },
        { case_id: "b", score: -0.2 }, { case_id: "b", score: 0.1 },
        { case_id: "c", score: 0.5 },
    ];
    const first = clusterBootstrapMean(items, { iterations: 500, seed: "fixa" });
    const second = clusterBootstrapMean(items, { iterations: 500, seed: "fixa" });
    assert.deepEqual(first, second);
    assert.equal(first.clusters, 3);
    assert.ok(first.low <= first.high);
    assert.equal(twoSidedSignTest(5, 0).p_value, 0.0625);
    assert.equal(twoSidedSignTest(0, 0).p_value, 1);
});

test("comparativo agrega modelos e explicita repeticoes por versao S-J", () => {
    const modelA = "openai:model-a:high";
    const modelB = "anthropic:model-b:high";
    const overall = (mean) => ({ judgments: 1, quality: { mean, median: mean, wins: mean > 0 ? 1 : 0, ties: 0, losses: mean < 0 ? 1 : 0 }, latency_ms: { p50: 100, p95: 100 }, cost: { candidate_usd: 0.1, judge_usd: 0.2 } });
    const runs = [
        { run_key: "r1", finished_at: "2026-07-10T10:00:00Z", metrics_json: { models: { [modelA]: { overall: overall(0.5) }, [modelB]: { overall: overall(0.8) } } } },
        { run_key: "r2", finished_at: "2026-07-11T10:00:00Z", metrics_json: { models: { [modelA]: { overall: overall(-0.5) } } } },
    ];
    const consensus = [
        { run_key: "r1", case_id: "c1", turn_id: "t1", candidate_key: modelA, score_general: "0.5", dimensions_json: {}, agreement_json: {}, candidate_latency_ms: 100 },
        { run_key: "r2", case_id: "c1", turn_id: "t1", candidate_key: modelA, score_general: "-0.5", dimensions_json: {}, agreement_json: {}, candidate_latency_ms: 120 },
        { run_key: "r1", case_id: "c1", turn_id: "t1", candidate_key: modelB, score_general: "0.8", dimensions_json: {}, agreement_json: {}, candidate_latency_ms: 80 },
    ];
    const ledger = [
        { run_key: "r1", provider: "openai", model: "model-a", effort: "high", role: "candidate", cost_estimated_usd: "0.10", cost_source: "estimated" },
        { run_key: "r2", provider: "openai", model: "model-a", effort: "high", role: "candidate", cost_estimated_usd: "0.14", cost_source: "estimated" },
        { run_key: "r1", provider: "judge", model: "best", effort: "high", role: "judge", candidate_key: modelA, cost_estimated_usd: "0.30", cost_source: "estimated" },
        { run_key: "r2", provider: "judge", model: "best", effort: "high", role: "judge", candidate_key: modelA, cost_estimated_usd: "0.40", cost_source: "estimated" },
        { run_key: "r1", provider: "anthropic", model: "model-b", effort: "high", role: "candidate", cost_estimated_usd: "0.20", cost_source: "estimated" },
    ];

    const comparison = buildReleaseComparison({ runs, consensus, ledger });
    assert.equal(comparison.completed_runs, 2);
    assert.equal(comparison.models[0].candidate_key, modelB);
    const aggregateA = comparison.models.find((item) => item.candidate_key === modelA);
    assert.equal(aggregateA.evaluations, 2);
    assert.equal(aggregateA.judgments, 2);
    assert.equal(aggregateA.unique_states, 1);
    assert.equal(aggregateA.overall.quality.mean, 0);
    assert.ok(Math.abs(aggregateA.overall.cost.candidate_usd - 0.24) < 1e-9);
    assert.ok(Math.abs(aggregateA.overall.cost.candidate_per_evaluation_usd - 0.12) < 1e-9);
    assert.equal(aggregateA.cost_completeness.candidate_unknown_calls, 0);
    assert.equal(aggregateA.runs[0].run_key, "r2");
});

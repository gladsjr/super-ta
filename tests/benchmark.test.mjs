import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCases } from "../lib/bench/cases.js";
import { runBenchmark } from "../lib/bench/runner.js";
import { buildConsensus } from "../lib/bench/consensus.js";
import { retrieveEvidence } from "../lib/bench/rag.js";
import { clusterBootstrapMean, twoSidedSignTest } from "../lib/bench/statistics.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("carrega e valida os cinco casos seed", () => {
    const cases = loadCases(path.join(projectRoot, "bench", "cases"));
    assert.equal(cases.length, 5);
    assert.equal(cases.reduce((sum, item) => sum + item.turns.length, 0), 10);
    assert.ok(cases.every((item) => /^[a-f0-9]{64}$/.test(item.document_hash)));
});

test("run dry-run produz pacote reproduzivel sem chamadas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-bench-"));
    const result = await runBenchmark({
        benchmark: "ORATIA-Bench", setup_version: "S0", context_version: "C0", jury_version: "J0",
        mode: "frozen-turn", cases_dir: path.join(projectRoot, "bench", "cases"), case_ids: ["eco-inflacao-juros"],
        candidates: ["openai:gpt-5.6-luna:medium"], judges: ["openai:gpt-5.6-sol:high"],
        storage: { runs_dir: dir }, limits: { max_cost_usd: 1 },
    }, { dryRun: true });
    assert.equal(result.run.status, "validated");
    assert.equal(result.run.turns, 2);
    for (const file of ["manifest.json", "config.resolved.json", "cases.json", "ledger.jsonl", "metrics.json", "summary.md", "raw.json"]) {
        assert.ok(fs.existsSync(path.join(result.runDir, file)), file);
    }
    assert.equal(fs.readFileSync(path.join(result.runDir, "ledger.jsonl"), "utf8"), "");
});

test("normaliza julgamento de acordo com a posicao randomizada", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-bench-"));
    const fake = {
        async generateInterviewTurn() {
            return { text: "Resposta candidata", request: {}, response: {}, usage: {}, latency_ms: 12, cost: { cost_usd: 0.01 } };
        },
        async judgePair() {
            return { parsed: { winner: "A", score: 0.7, dimensions: { relevance: 0.5 }, confidence: 0.9, critical_failure: false, rationale: "A foi melhor" }, request: {}, response: {}, usage: {}, latency_ms: 20, cost: { cost_usd: 0.02 } };
        },
    };
    const result = await runBenchmark({
            benchmark: "ORATIA-Bench", setup_version: "S0", context_version: "C0", jury_version: "J0", mode: "frozen-turn",
            random_seed: 20260711,
            cases_dir: path.join(projectRoot, "bench", "cases"), case_ids: ["eco-inflacao-juros"],
            candidates: ["fake:model:medium"], judges: ["fake:judge:high"], storage: { runs_dir: dir }, limits: { max_cost_usd: 2 },
        }, { adapters: { fake } });
        const raw = JSON.parse(fs.readFileSync(path.join(result.runDir, "raw.json"), "utf8"));
        const first = raw.judgments[0];
        const direction = first.candidate_position === "A" ? 1 : -1;
        assert.equal(first.score, direction * 0.7);
        assert.equal(first.dimensions.relevance, direction * 0.5);
        assert.equal(result.metrics.models["fake:model:medium"].overall.cost.candidate_usd, 0.02);
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
    const testCase = loadCases(path.join(projectRoot, "bench", "cases"), ["adm-restaurante-energia"])[0];
    const first = retrieveEvidence(testCase, testCase.turns[1], { chunk_chars: 120, top_k: 3 });
    const second = retrieveEvidence(testCase, testCase.turns[1], { chunk_chars: 120, top_k: 3 });
    assert.equal(first.package_hash, second.package_hash);
    assert.deepEqual(first.chunks.map((item) => item.id), second.chunks.map((item) => item.id));
    assert.ok(first.chunks.some((item) => item.content.includes("14%")));
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

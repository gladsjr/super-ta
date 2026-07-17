import { mean, median, percentile } from "./util.js";
import { clusterBootstrapMean, twoSidedSignTest } from "./statistics.js";

export function summarizeJudgments(items) {
    const scores = items.map((item) => item.score);
    const latencies = items.map((item) => item.candidate_latency_ms).filter(Number.isFinite);
    const dimensions = {};
    for (const name of new Set(items.flatMap((item) => Object.keys(item.dimensions || {})))) {
        dimensions[name] = mean(items.map((item) => item.dimensions?.[name]).filter(Number.isFinite));
    }
    const wins = scores.filter((score) => score > 0.15).length;
    const losses = scores.filter((score) => score < -0.15).length;
    const assessments = items.map((item) => item.action_assessment || {}).filter((item) => Object.keys(item).length);
    const rate = (field) => assessments.length ? assessments.filter((item) => item[field]).length / assessments.length : null;
    const confusion = {};
    for (const assessment of assessments) {
        const expected = assessment.expected_preferred_kind || "nao_definido";
        const actual = assessment.action_kind || "invalido";
        confusion[expected] ||= {};
        confusion[expected][actual] = (confusion[expected][actual] || 0) + 1;
    }
    return {
        judgments: items.length,
        quality: {
            mean: mean(scores),
            median: median(scores),
            score_sum: scores.reduce((sum, score) => sum + Number(score || 0), 0),
            score_distribution: scoreDistribution(scores),
            mean_ci95: clusterBootstrapMean(items),
            wins,
            ties: scores.filter((score) => Math.abs(score) <= 0.15).length,
            losses,
            sign_test: twoSidedSignTest(wins, losses),
            critical_failures: items.filter((item) => item.critical_failure).length,
            needs_deliberation: items.filter((item) => item.needs_deliberation).length,
            mean_judge_spread: mean(items.map((item) => item.agreement?.score_spread).filter(Number.isFinite)),
            dimensions,
        },
        latency_ms: {
            mean: mean(latencies),
            p50: percentile(latencies, 0.5),
            p90: percentile(latencies, 0.9),
            p95: percentile(latencies, 0.95),
        },
        action_policy: {
            states: assessments.length,
            schema_valid_rate: rate("schema_valid"),
            preferred_rate: rate("preferred"),
            acceptable_rate: rate("acceptable"),
            forbidden_rate: rate("forbidden"),
            required_fields_match_rate: rate("required_fields_match"),
            critical_failure_rate: rate("critical_failure"),
            confusion,
        },
    };
}

function scoreDistribution(scores) {
    const buckets = { "-1": 0, "-0.5": 0, "0": 0, "+0.5": 0, "+1": 0 };
    for (const score of scores) {
        if (score <= -0.75) buckets["-1"] += 1;
        else if (score < -0.15) buckets["-0.5"] += 1;
        else if (score <= 0.15) buckets["0"] += 1;
        else if (score < 0.75) buckets["+0.5"] += 1;
        else buckets["+1"] += 1;
    }
    return buckets;
}

export function calculateMetrics(judgments, ledgerEntries) {
    const models = {};
    for (const model of new Set(judgments.map((item) => item.candidate_key))) {
        const rows = judgments.filter((item) => item.candidate_key === model);
        const candidateCalls = ledgerEntries.filter((item) => ["candidate", "candidate_latency_repeat"].includes(item.role) && `${item.provider}:${item.model}${item.effort ? `:${item.effort}` : ""}` === model);
        const judgeCalls = ledgerEntries.filter((item) => ["judge", "judge_retry"].includes(item.role) && item.candidate_key === model);
        const overall = summarizeJudgments(rows);
        const allLatencies = candidateCalls.map((item) => item.latency_ms).filter(Number.isFinite);
        overall.latency_ms = {
            mean: mean(allLatencies), p50: percentile(allLatencies, 0.5),
            p90: percentile(allLatencies, 0.9), p95: percentile(allLatencies, 0.95),
            samples: allLatencies.length,
        };
        overall.cost = {
            candidate_usd: candidateCalls.reduce((sum, item) => sum + Number(item.cost_estimated_usd || 0), 0),
            judge_usd: judgeCalls.reduce((sum, item) => sum + Number(item.cost_estimated_usd || 0), 0),
        };
        models[model] = {
            overall,
            by_area: Object.fromEntries([...new Set(rows.map((item) => item.area))].map((area) => [area, summarizeJudgments(rows.filter((item) => item.area === area))])),
            by_persona: Object.fromEntries([...new Set(rows.map((item) => item.persona))].map((persona) => [persona, summarizeJudgments(rows.filter((item) => item.persona === persona))])),
        };
    }
    return {
        models,
        run_cost_usd: ledgerEntries.reduce((sum, item) => sum + Number(item.cost_estimated_usd || 0), 0),
        cost_completeness: {
            known_calls: ledgerEntries.filter((item) => item.cost_estimated_usd != null).length,
            unknown_calls: ledgerEntries.filter((item) => item.cost_estimated_usd == null).length,
            exact_calls: ledgerEntries.filter((item) => item.cost_source === "exact").length,
        },
        calls: ledgerEntries.length,
    };
}

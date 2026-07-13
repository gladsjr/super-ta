import { mean, median, percentile } from "./util.js";
import { clusterBootstrapMean, twoSidedSignTest } from "./statistics.js";

function summarize(items) {
    const scores = items.map((item) => item.score);
    const latencies = items.map((item) => item.candidate_latency_ms);
    const dimensions = {};
    for (const name of new Set(items.flatMap((item) => Object.keys(item.dimensions || {})))) {
        dimensions[name] = mean(items.map((item) => item.dimensions?.[name]).filter(Number.isFinite));
    }
    const wins = scores.filter((score) => score > 0.15).length;
    const losses = scores.filter((score) => score < -0.15).length;
    return {
        judgments: items.length,
        quality: {
            mean: mean(scores),
            median: median(scores),
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
    };
}

export function calculateMetrics(judgments, ledgerEntries) {
    const models = {};
    for (const model of new Set(judgments.map((item) => item.candidate_key))) {
        const rows = judgments.filter((item) => item.candidate_key === model);
        const candidateCalls = ledgerEntries.filter((item) => item.role === "candidate" && `${item.provider}:${item.model}${item.effort ? `:${item.effort}` : ""}` === model);
        const judgeCalls = ledgerEntries.filter((item) => item.role === "judge" && item.candidate_key === model);
        const overall = summarize(rows);
        overall.cost = {
            candidate_usd: candidateCalls.reduce((sum, item) => sum + Number(item.cost_estimated_usd || 0), 0),
            judge_usd: judgeCalls.reduce((sum, item) => sum + Number(item.cost_estimated_usd || 0), 0),
        };
        models[model] = {
            overall,
            by_area: Object.fromEntries([...new Set(rows.map((item) => item.area))].map((area) => [area, summarize(rows.filter((item) => item.area === area))])),
            by_persona: Object.fromEntries([...new Set(rows.map((item) => item.persona))].map((persona) => [persona, summarize(rows.filter((item) => item.persona === persona))])),
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

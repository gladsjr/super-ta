import { summarizeJudgments } from "./metrics.js";

function numberOrNull(value) {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function candidateKey(entry) {
    return `${entry.provider}:${entry.model}${entry.effort ? `:${entry.effort}` : ""}`;
}

function sumCost(entries) {
    return entries.reduce((sum, entry) => sum + Number(entry.cost_estimated_usd || 0), 0);
}

function runSummary(run, modelKey) {
    const overall = run.metrics_json?.models?.[modelKey]?.overall;
    if (!overall) return null;
    return {
        run_key: run.run_key,
        started_at: run.started_at,
        finished_at: run.finished_at,
        overall,
    };
}

export function buildReleaseComparison({ runs = [], consensus = [], ledger = [] } = {}) {
    const rows = consensus.map((row) => ({
        ...row,
        case_id: `${row.run_key}:${row.case_id}`,
        original_case_id: row.case_id,
        score: Number(row.score_general),
        dimensions: row.dimensions_json || {},
        confidence: numberOrNull(row.confidence),
        candidate_latency_ms: numberOrNull(row.candidate_latency_ms),
        agreement: row.agreement_json || {},
        action_assessment: row.action_assessment_json || {},
    }));
    const normalizedLedger = ledger.map((entry) => ({
        ...entry,
        cost_estimated_usd: numberOrNull(entry.cost_estimated_usd),
        latency_ms: numberOrNull(entry.latency_ms),
    }));
    const modelKeys = [...new Set(rows.map((row) => row.candidate_key))].sort();

    const models = modelKeys.map((modelKey) => {
        const modelRows = rows.filter((row) => row.candidate_key === modelKey);
        const candidateCalls = normalizedLedger.filter((entry) => ["candidate", "candidate_latency_repeat"].includes(entry.role) && candidateKey(entry) === modelKey);
        const judgeCalls = normalizedLedger.filter((entry) => ["judge", "judge_retry"].includes(entry.role) && entry.candidate_key === modelKey);
        const relatedCalls = [...candidateCalls, ...judgeCalls];
        const history = runs.map((run) => runSummary(run, modelKey)).filter(Boolean).sort((a, b) => String(b.finished_at || "").localeCompare(String(a.finished_at || "")));
        const overall = summarizeJudgments(modelRows);
        overall.cost = {
            candidate_usd: sumCost(candidateCalls),
            judge_usd: sumCost(judgeCalls),
            candidate_per_evaluation_usd: history.length ? sumCost(candidateCalls) / history.length : null,
            judge_per_evaluation_usd: history.length ? sumCost(judgeCalls) / history.length : null,
        };

        return {
            candidate_key: modelKey,
            evaluations: history.length,
            judgments: modelRows.length,
            unique_states: new Set(modelRows.map((row) => `${row.original_case_id}:${row.turn_id}`)).size,
            first_finished_at: history.at(-1)?.finished_at || null,
            last_finished_at: history[0]?.finished_at || null,
            cost_completeness: {
                known_calls: relatedCalls.filter((entry) => entry.cost_estimated_usd != null).length,
                unknown_calls: relatedCalls.filter((entry) => entry.cost_estimated_usd == null).length,
                exact_calls: relatedCalls.filter((entry) => entry.cost_source === "exact").length,
                candidate_unknown_calls: candidateCalls.filter((entry) => entry.cost_estimated_usd == null).length,
                judge_unknown_calls: judgeCalls.filter((entry) => entry.cost_estimated_usd == null).length,
            },
            overall,
            runs: history,
        };
    }).sort((a, b) => (b.overall.quality.mean ?? -Infinity) - (a.overall.quality.mean ?? -Infinity));

    return {
        completed_runs: runs.length,
        model_evaluations: models.reduce((sum, model) => sum + model.evaluations, 0),
        judgments: rows.length,
        unique_states: new Set(rows.map((row) => `${row.original_case_id}:${row.turn_id}`)).size,
        models,
    };
}

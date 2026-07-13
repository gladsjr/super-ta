import { mean, median } from "./util.js";

function standardDeviation(values) {
    if (values.length < 2) return 0;
    const avg = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

export function buildConsensus(judgments, { disagreement_threshold = 0.65 } = {}) {
    const groups = new Map();
    for (const item of judgments) {
        const key = `${item.case_id}\u0000${item.turn_id}\u0000${item.candidate_key}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return [...groups.values()].map((votes) => {
        const scores = votes.map((vote) => vote.score);
        const dimensionNames = new Set(votes.flatMap((vote) => Object.keys(vote.dimensions || {})));
        const dimensions = Object.fromEntries([...dimensionNames].map((name) => [name, median(votes.map((vote) => vote.dimensions?.[name]).filter(Number.isFinite))]));
        const spread = Math.max(...scores) - Math.min(...scores);
        return {
            case_id: votes[0].case_id,
            turn_id: votes[0].turn_id,
            area: votes[0].area,
            large_area: votes[0].large_area,
            persona: votes[0].persona,
            candidate_key: votes[0].candidate_key,
            score: median(scores),
            dimensions,
            confidence: median(votes.map((vote) => vote.confidence).filter(Number.isFinite)),
            critical_failure: votes.filter((vote) => vote.critical_failure).length > votes.length / 2,
            judge_count: votes.length,
            agreement: {
                score_stddev: standardDeviation(scores),
                score_spread: spread,
                positive: scores.filter((score) => score > 0.15).length,
                neutral: scores.filter((score) => Math.abs(score) <= 0.15).length,
                negative: scores.filter((score) => score < -0.15).length,
            },
            needs_deliberation: votes.length > 1 && spread >= disagreement_threshold,
        };
    });
}

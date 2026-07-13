import { mean, seededRandom } from "./util.js";

function quantile(sorted, p) {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index), upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function clusterBootstrapMean(items, { iterations = 2000, seed = "oratia-bootstrap" } = {}) {
    if (!items.length) return { low: null, high: null, iterations: 0, clusters: 0 };
    const groups = new Map();
    for (const item of items) {
        if (!groups.has(item.case_id)) groups.set(item.case_id, []);
        groups.get(item.case_id).push(item.score);
    }
    const clusterIds = [...groups.keys()].sort();
    if (clusterIds.length === 1) return { low: mean(groups.get(clusterIds[0])), high: mean(groups.get(clusterIds[0])), iterations: 0, clusters: 1 };
    const random = seededRandom(seed);
    const samples = [];
    for (let i = 0; i < iterations; i++) {
        const values = [];
        for (let j = 0; j < clusterIds.length; j++) {
            const id = clusterIds[Math.floor(random() * clusterIds.length)];
            values.push(...groups.get(id));
        }
        samples.push(mean(values));
    }
    samples.sort((a, b) => a - b);
    return { low: quantile(samples, 0.025), high: quantile(samples, 0.975), iterations, clusters: clusterIds.length };
}

function combination(n, k) {
    k = Math.min(k, n - k);
    let result = 1;
    for (let i = 1; i <= k; i++) result = result * (n - k + i) / i;
    return result;
}

export function twoSidedSignTest(wins, losses) {
    const n = wins + losses;
    if (!n) return { n: 0, p_value: 1 };
    const extreme = Math.min(wins, losses);
    let tail = 0;
    for (let k = 0; k <= extreme; k++) tail += combination(n, k) * (0.5 ** n);
    return { n, p_value: Math.min(1, 2 * tail) };
}

import crypto from "node:crypto";

export function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function sha256(value) {
    return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

export function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[index];
}

export function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function parseModelSpec(spec) {
    const [provider, model, effort = null] = String(spec || "").split(":");
    if (!provider || !model) throw new Error(`modelo invalido: "${spec}"; use fornecedor:modelo[:esforco]`);
    return { provider, model, effort, key: `${provider}:${model}${effort ? `:${effort}` : ""}` };
}

export function seededRandom(seed) {
    let state = Number.parseInt(sha256(String(seed)).slice(0, 8), 16) || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
}

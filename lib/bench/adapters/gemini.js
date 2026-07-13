import { fetchJson, parseJsonText, standardInstructions, tokenCost } from "./common.js";

function thinkingLevel(effort) {
    if (!effort) return null;
    if (["none", "minimal"].includes(effort)) return "minimal";
    if (["xhigh", "max"].includes(effort)) return "high";
    return effort;
}

export class GeminiAdapter {
    constructor({ apiKey = process.env.GEMINI_API_KEY, timeoutMs = 90000, retries = 2, pricing = {} } = {}) {
        if (!apiKey) throw new Error("GEMINI_API_KEY ausente");
        this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.retries = retries; this.pricing = pricing;
    }

    capabilities() { return { structured_output: true, reasoning_effort: true, usage_tokens: true, exact_cost: false, admin_cost_api: false }; }

    async call({ spec, role, prompt }) {
        const generationConfig = { maxOutputTokens: role === "judge" ? 1800 : 700 };
        const level = thinkingLevel(spec.effort);
        if (level) generationConfig.thinkingConfig = { thinkingLevel: level };
        if (role === "judge") generationConfig.responseMimeType = "application/json";
        const body = { systemInstruction: { parts: [{ text: standardInstructions(role) }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig };
        const started = performance.now();
        const response = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(spec.model)}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body) }, this);
        const latency = Math.round(performance.now() - started);
        const text = (response.candidates?.[0]?.content?.parts || []).filter((item) => !item.thought && item.text).map((item) => item.text).join("\n").trim();
        const usage = response.usageMetadata || {};
        const tokens = { input: Number(usage.promptTokenCount || 0), cached: Number(usage.cachedContentTokenCount || 0), output: Number(usage.candidatesTokenCount || 0) + Number(usage.thoughtsTokenCount || 0) };
        return { request: body, response, text, usage, cost: { ...tokenCost(tokens, this.pricing[spec.model]), ...tokens }, latency_ms: latency };
    }

    generateInterviewTurn({ spec, prompt }) { return this.call({ spec, role: "candidate", prompt }); }
    async judgePair({ spec, prompt }) { const result = await this.call({ spec, role: "judge", prompt }); return { ...result, parsed: parseJsonText(result.text) }; }
}

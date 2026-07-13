import { fetchJson, parseJsonText, standardInstructions, tokenCost } from "./common.js";

export class AnthropicAdapter {
    constructor({ apiKey = process.env.ANTHROPIC_API_KEY, timeoutMs = 90000, retries = 2, pricing = {} } = {}) {
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY ausente");
        this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.retries = retries; this.pricing = pricing;
    }

    capabilities() { return { structured_output: false, reasoning_effort: true, usage_tokens: true, exact_cost: false, admin_cost_api: true }; }

    async call({ spec, role, prompt }) {
        const body = { model: spec.model, max_tokens: role === "judge" ? 1800 : 700, system: standardInstructions(role), messages: [{ role: "user", content: prompt }] };
        if (spec.effort) {
            body.output_config = { effort: spec.effort };
            body.thinking = { type: "adaptive" };
        }
        const started = performance.now();
        const response = await fetchJson("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) }, this);
        const latency = Math.round(performance.now() - started);
        const text = (response.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
        const usage = response.usage || {};
        const tokens = { input: Number(usage.input_tokens || 0), cached: Number(usage.cache_read_input_tokens || 0), cacheWrite: Number(usage.cache_creation_input_tokens || 0), output: Number(usage.output_tokens || 0) };
        return { request: body, response, text, usage, cost: { ...tokenCost(tokens, this.pricing[spec.model]), ...tokens }, latency_ms: latency };
    }

    generateInterviewTurn({ spec, prompt }) { return this.call({ spec, role: "candidate", prompt }); }
    async judgePair({ spec, prompt }) { const result = await this.call({ spec, role: "judge", prompt }); return { ...result, parsed: parseJsonText(result.text) }; }
}

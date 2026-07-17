import { fetchJson, standardInstructions, tryParseJsonText } from "./common.js";
import { orchestratorJudgmentSchema, orchestratorOutputSchema, setupVoteSchema, studentReplySchema } from "../orchestratorContract.js";

function responseText(response) {
    if (response.output_text) return response.output_text;
    return (response.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("\n");
}

export class XaiAdapter {
    constructor({ apiKey = process.env.XAI_API_KEY, timeoutMs = 90000, retries = 2 } = {}) {
        if (!apiKey) throw new Error("XAI_API_KEY ausente");
        this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.retries = retries;
    }

    capabilities() { return { structured_output: false, reasoning_effort: true, usage_tokens: true, exact_cost: true, admin_cost_api: false }; }

    async call({ spec, role, prompt, schema = null }) {
        const body = { model: spec.model, instructions: standardInstructions(role), input: prompt };
        if (spec.effort) body.reasoning = { effort: spec.effort };
        if (schema) body.text = { format: { type: "json_schema", name: `oratia_${role}`, schema, strict: true } };
        const started = performance.now();
        const response = await fetchJson("https://api.x.ai/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) }, this);
        const latency = Math.round(performance.now() - started);
        const usage = response.usage || {};
        const ticks = Number(usage.cost_in_usd_ticks);
        const cost = Number.isFinite(ticks) ? ticks / 10_000_000_000 : null;
        const text = responseText(response).trim();
        return { request: body, response, text, parsed: schema ? tryParseJsonText(text) : null, usage, cost: { cost_usd: cost, cost_source: cost == null ? "unavailable" : "exact", input: Number(usage.input_tokens || 0), cached: Number(usage.input_tokens_details?.cached_tokens || 0), output: Number(usage.output_tokens || 0) }, latency_ms: latency };
    }

    judgePair({ spec, prompt }) { return this.call({ spec, role: "judge", prompt, schema: orchestratorJudgmentSchema }); }
    generateOrchestratorTurn({ spec, prompt }) { return this.call({ spec, role: "candidate", prompt, schema: orchestratorOutputSchema }); }
    generateSetupProposal(args) { return this.generateOrchestratorTurn(args); }
    voteSetup({ spec, prompt }) { return this.call({ spec, role: "setup_vote", prompt, schema: setupVoteSchema }); }
    generateStudentReply({ spec, prompt }) { return this.call({ spec, role: "student", prompt, schema: studentReplySchema }); }
}

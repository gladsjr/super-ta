import { fetchJson, standardInstructions, tokenCost, tryParseJsonText } from "./common.js";
import { orchestratorJudgmentSchema, orchestratorOutputSchema, setupVoteSchema, studentReplySchema } from "../orchestratorContract.js";

export class AnthropicAdapter {
    // Chave DEDICADA do benchmark (ver nota no OpenAIAdapter): separa gastos e
    // viabiliza auditoria de custo; sem fallback para ANTHROPIC_API_KEY.
    constructor({ apiKey = process.env.ANTHROPIC_API_KEY_BENCHMARK, timeoutMs = 90000, retries = 2, pricing = {} } = {}) {
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY_BENCHMARK ausente — o benchmark usa chave própria para separar gastos; defina-a no .env");
        this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.retries = retries; this.pricing = pricing;
    }

    capabilities() { return { structured_output: false, reasoning_effort: true, usage_tokens: true, exact_cost: false, admin_cost_api: true }; }

    async call({ spec, role, prompt, schema = null, toolName = null }) {
        const maxTokens = { judge: 2200, candidate: 1600, setup_vote: 1000, student: 800 }[role] || 1200;
        const body = { model: spec.model, max_tokens: maxTokens, system: standardInstructions(role), messages: [{ role: "user", content: prompt }] };
        if (schema && toolName) {
            body.tools = [{ name: toolName, description: "Registra a saida estruturada do ORATIA Bench.", input_schema: schema }];
            body.tool_choice = { type: "tool", name: toolName };
        }
        if (spec.effort) {
            body.output_config = { effort: spec.effort };
            if (!["claude-fable-5", "claude-mythos-5", "claude-sonnet-5"].includes(spec.model)) body.thinking = { type: "adaptive" };
        }
        const started = performance.now();
        const response = await fetchJson("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) }, this);
        const latency = Math.round(performance.now() - started);
        const text = (response.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
        const usage = response.usage || {};
        const tokens = { input: Number(usage.input_tokens || 0), cached: Number(usage.cache_read_input_tokens || 0), cacheWrite: Number(usage.cache_creation_input_tokens || 0), output: Number(usage.output_tokens || 0) };
        const parsed = toolName ? (response.content || []).find((item) => item.type === "tool_use" && item.name === toolName)?.input : null;
        return { request: body, response, text, parsed, usage, cost: { ...tokenCost(tokens, this.pricing[spec.model]), ...tokens }, latency_ms: latency };
    }

    async judgePair({ spec, prompt }) {
        const result = await this.call({ spec, role: "judge", prompt, schema: orchestratorJudgmentSchema, toolName: "record_judgment" });
        return { ...result, parsed: result.parsed || tryParseJsonText(result.text) };
    }
    generateOrchestratorTurn({ spec, prompt }) { return this.call({ spec, role: "candidate", prompt, schema: orchestratorOutputSchema, toolName: "record_orchestrator_output" }); }
    generateSetupProposal(args) { return this.generateOrchestratorTurn(args); }
    voteSetup({ spec, prompt }) { return this.call({ spec, role: "setup_vote", prompt, schema: setupVoteSchema, toolName: "record_setup_vote" }); }
    generateStudentReply({ spec, prompt }) { return this.call({ spec, role: "student", prompt, schema: studentReplySchema, toolName: "record_student_reply" }); }
}

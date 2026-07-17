import OpenAI from "openai";
import { computeResponsesCost } from "../../billing.js";
import {
    orchestratorJudgmentSchema,
    orchestratorOutputSchema,
    setupVoteSchema,
    studentReplySchema,
} from "../orchestratorContract.js";
import { standardInstructions } from "./common.js";

function reasoning(effort) {
    return effort ? { reasoning: { effort } } : {};
}

function parseJson(text) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
}

export class OpenAIAdapter {
    constructor({ client = null, timeoutMs = 90000, retries = 2 } = {}) {
        this.client = client || new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: timeoutMs, maxRetries: retries });
    }

    capabilities() {
        return { structured_output: true, reasoning_effort: true, usage_tokens: true, exact_cost: false };
    }

    async call({ model, effort, instructions, input, text = null }) {
        const request = { model, instructions, input, ...reasoning(effort) };
        if (text) request.text = text;
        const started = performance.now();
        const response = await this.client.responses.create(request);
        const latencyMs = Math.round(performance.now() - started);
        const cost = computeResponsesCost(response.usage, model);
        return {
            request,
            response,
            text: String(response.output_text || "").trim(),
            usage: response.usage || {},
            cost: { ...cost, cost_source: "estimated" },
            latency_ms: latencyMs,
        };
    }

    async structured({ spec, prompt, role, schema, name }) {
        const result = await this.call({
            model: spec.model, effort: spec.effort, instructions: standardInstructions(role), input: prompt,
            text: { format: { type: "json_schema", name, schema, strict: true } },
        });
        return { ...result, parsed: parseJson(result.text) };
    }

    async judgePair({ spec, prompt }) {
        return this.structured({ spec, prompt, role: "judge", schema: orchestratorJudgmentSchema, name: "oratia_orchestrator_judgment" });
    }

    generateOrchestratorTurn({ spec, prompt }) { return this.structured({ spec, prompt, role: "candidate", schema: orchestratorOutputSchema, name: "oratia_orchestrator_output" }); }
    generateSetupProposal(args) { return this.generateOrchestratorTurn(args); }
    voteSetup({ spec, prompt }) { return this.structured({ spec, prompt, role: "setup_vote", schema: setupVoteSchema, name: "oratia_setup_vote" }); }
    generateStudentReply({ spec, prompt }) { return this.structured({ spec, prompt, role: "student", schema: studentReplySchema, name: "oratia_student_reply" }); }
}

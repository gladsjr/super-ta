import OpenAI from "openai";
import { computeResponsesCost } from "../../billing.js";

function reasoning(effort) {
    return effort ? { reasoning: { effort } } : {};
}

function parseJson(text) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("resposta do juiz nao contem JSON");
    return JSON.parse(match[0]);
}

export class OpenAIAdapter {
    constructor({ client = null, timeoutMs = 90000, retries = 2 } = {}) {
        this.client = client || new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: timeoutMs, maxRetries: retries });
    }

    capabilities() {
        return { structured_output: true, reasoning_effort: true, usage_tokens: true, exact_cost: false };
    }

    async call({ model, effort, instructions, input }) {
        const request = { model, instructions, input, ...reasoning(effort) };
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

    async generateInterviewTurn({ spec, prompt }) {
        return this.call({
            model: spec.model,
            effort: spec.effort,
            instructions: "Voce conduz uma entrevista oral do ORATIA. Produza somente a proxima fala da pessoa entrevistadora, em portugues brasileiro, natural, concisa e com um foco por vez. Nao explique sua decisao e nao use listas.",
            input: prompt,
        });
    }

    async judgePair({ spec, prompt }) {
        const result = await this.call({
            model: spec.model,
            effort: spec.effort,
            instructions: "Voce e um juiz independente do ORATIA Bench. Avalie cegamente as duas respostas usando apenas o contexto e a rubrica fornecidos. A resposta de referencia pode ser superada. Retorne somente JSON valido.",
            input: prompt,
        });
        return { ...result, parsed: parseJson(result.text) };
    }
}

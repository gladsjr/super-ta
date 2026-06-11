// Instrumentação de chamadas à OpenAI para o teste A/B do super-orquestrador.
//
// O cliente real (lib/openaiClient.js) é embrulhado num Proxy que intercepta
// SOMENTE `responses.create` para registrar, por chamada: modelo, usage
// (tokens) e latência de parede (ms). Todo o resto (files, vectorStores,
// conversations) delega ao cliente real sem alteração.
//
// Por que um Proxy e não mexer no billing.js: os agentes chamam
// `this.client.responses.create` por dentro do `meteredResponses`. Trocando o
// `this.client` por este Proxy, capturamos custo+latência reais SEM tocar em
// código de produção e SEM depender do Postgres (o billing de produção só
// grava no banco quando há workId; aqui passamos workId=null).

import { openai as realOpenai } from "../../lib/openaiClient.js";
import { computeResponsesCost } from "../../lib/billing.js";

// Cria um cliente instrumentado cujas chamadas de responses.create caem em
// `sink` (array). Use um sink por papel (driver-principal, counterfactual-fast,
// fast-independente, prep, juiz) para separar custos.
export function makeInstrumentedClient(sink) {
    return new Proxy(realOpenai, {
        get(target, prop, receiver) {
            if (prop === "responses") {
                return {
                    create: async (payload) => {
                        const t0 = Date.now();
                        const res = await target.responses.create(payload);
                        const latencyMs = Date.now() - t0;
                        // O driver nunca usa stream (não passa onFirstDelta), então
                        // `res` é sempre uma Response plana com `.usage`.
                        sink.push({ model: payload?.model ?? null, usage: res?.usage ?? null, latencyMs });
                        return res;
                    },
                };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return null;
    const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
    return sortedAsc[idx];
}

// Agrega um sink em métricas comparáveis. `model` é necessário para o custo
// (a tabela de preços é por modelo). Se um sink tiver modelos misturados,
// o custo é somado corretamente por chamada, mas as estatísticas de latência
// são do conjunto todo.
export function summarizeSink(sink) {
    let totalCost = 0;
    let inTok = 0, cachedTok = 0, outTok = 0;
    const latencies = [];
    for (const rec of sink) {
        latencies.push(rec.latencyMs);
        if (!rec.usage || !rec.model) continue;
        const c = computeResponsesCost(rec.usage, rec.model);
        totalCost += c.cost_usd;
        inTok += c.input_tokens;
        cachedTok += c.cached_tokens;
        outTok += c.output_tokens;
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    return {
        calls: sink.length,
        total_cost_usd: totalCost,
        input_tokens: inTok,
        cached_tokens: cachedTok,
        output_tokens: outTok,
        latency_ms: {
            mean: mean != null ? Math.round(mean) : null,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            max: sorted.length ? sorted[sorted.length - 1] : null,
        },
    };
}

export function parseJsonText(text) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("resposta do juiz nao contem JSON");
    return JSON.parse(match[0]);
}

export function tryParseJsonText(text) {
    try { return parseJsonText(text); } catch { return null; }
}

export { orchestratorJudgmentSchema as judgmentSchema } from "../orchestratorContract.js";

export async function fetchJson(url, options, { timeoutMs = 90000, retries = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const text = await response.text();
            let data;
            try { data = text ? JSON.parse(text) : {}; } catch { data = { raw_text: text }; }
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}: ${data?.error?.message || data?.message || text.slice(0, 500)}`);
                error.status = response.status;
                if (response.status < 500 && response.status !== 429) throw error;
                lastError = error;
            } else {
                return data;
            }
        } catch (err) {
            lastError = err;
            if (err?.status && err.status < 500 && err.status !== 429) throw err;
        } finally { clearTimeout(timer); }
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
    throw lastError;
}

export function tokenCost({ input = 0, cached = 0, cacheWrite = 0, output = 0 }, pricing = null) {
    if (!pricing) return { cost_usd: null, cost_source: "unavailable" };
    const billable = Math.max(0, input - cached - cacheWrite);
    const cost = (billable * Number(pricing.input_per_mtok || 0) + cached * Number(pricing.input_cached_per_mtok || pricing.input_per_mtok || 0) + cacheWrite * Number(pricing.cache_write_per_mtok || pricing.input_per_mtok || 0) + output * Number(pricing.output_per_mtok || 0)) / 1_000_000;
    return { cost_usd: cost, cost_source: "estimated" };
}

export function standardInstructions(role) {
    if (role === "judge") return "Voce e um juiz independente do ORATIA Bench. Compare cegamente as duas decisoes completas do superorquestrador. A referencia pode ser superada. Retorne somente o objeto estruturado solicitado.";
    if (role === "student") return "Simule fielmente o aluno descrito, sem melhorar artificialmente seu conhecimento. Retorne somente o objeto estruturado solicitado.";
    if (role === "setup_vote") return "Voce integra o conselho de setup do ORATIA Bench. Selecione a melhor proposta e delimite decisoes aceitaveis e proibidas. Retorne somente o objeto estruturado solicitado.";
    return "Voce opera como superorquestrador de uma entrevista oral do ORATIA. Decida a acao e produza o estado completo no formato estruturado solicitado.";
}

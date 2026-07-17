import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import { XaiAdapter } from "./xai.js";

export function createProviderAdapters(specs, config, provided = {}) {
    const adapters = { ...provided };
    const providers = new Set(specs.map((spec) => spec.provider));
    const options = { timeoutMs: config.limits?.timeout_ms, retries: config.limits?.retries };
    if (providers.has("openai") && !adapters.openai) adapters.openai = new OpenAIAdapter(options);
    if (providers.has("anthropic") && !adapters.anthropic) adapters.anthropic = new AnthropicAdapter({ ...options, pricing: config.providers?.anthropic?.pricing });
    if (providers.has("gemini") && !adapters.gemini) adapters.gemini = new GeminiAdapter({ ...options, pricing: config.providers?.gemini?.pricing });
    if (providers.has("xai") && !adapters.xai) adapters.xai = new XaiAdapter(options);
    for (const spec of specs) {
        if (!adapters[spec.provider]) throw new Error(`fornecedor nao configurado: ${spec.provider}`);
    }
    return adapters;
}

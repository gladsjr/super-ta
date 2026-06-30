// Cliente OpenAI singleton. Tudo que precisar falar com a API importa daqui.
// Evita múltiplas instâncias e centraliza a leitura da API key.

import OpenAI from "openai";
import { PRINCIPAL_REASONING_MODEL, PRINCIPAL_REASONING_EFFORT } from "./config.js";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Esforço de raciocínio do modelo principal aplicado de forma UNIFORME: quando uma
// chamada usa o modelo principal e há `principal_reasoning_effort` em policy.yaml,
// injeta `reasoning.effort` no payload. Não sobrescreve um `reasoning` explícito
// (ex.: opt-in do SuperOrchestratorAgent) nem afeta o modelo rápido/STT/TTS.
// Centralizado aqui para não repetir a injeção em cada um dos ~7 agentes.
if (PRINCIPAL_REASONING_EFFORT) {
    const _create = openai.responses.create.bind(openai.responses);
    openai.responses.create = (body, options) => {
        if (body && body.model === PRINCIPAL_REASONING_MODEL && !body.reasoning) {
            body = { ...body, reasoning: { effort: PRINCIPAL_REASONING_EFFORT } };
        }
        return _create(body, options);
    };
}

// Cliente OpenAI. Tudo que precisar falar com a API importa daqui.
// Centraliza a leitura da API key e a injeção uniforme de reasoning.effort.
//
// Duas chaves, dois clientes:
//   - `openai`            → produção (OPENAI_API_KEY). Singleton eager (sempre usado).
//   - cliente de benchmark → OPENAI_API_KEY_BENCHMARK (memoizado, fail-fast, SEM
//     fallback para a chave de produção). Um work marcado `is_benchmark` roteia
//     TODAS as suas chamadas por essa chave, para separar o gasto no painel da
//     OpenAI e viabilizar a auditoria via Usage/Costs API. Mesmo padrão de
//     lib/bench/adapters/openai.js.
//
// Para escolher o cliente/chave a partir de um work, use `clientForWork(work)`
// (objeto OpenAI, p/ Responses/STT/TTS/Files/etc.) e `apiKeyForWork(work)` (a
// string da chave, p/ o WebSocket do Realtime e o mint de token efêmero).

import OpenAI from "openai";
import { PRINCIPAL_REASONING_MODEL, PRINCIPAL_REASONING_EFFORT } from "./config.js";

// Aplica, IN PLACE, o wrapper de esforço de raciocínio do modelo principal: quando
// uma chamada usa o modelo principal e há `principal_reasoning_effort` em policy.yaml,
// injeta `reasoning.effort` no payload. Não sobrescreve um `reasoning` explícito
// (ex.: opt-in do SuperOrchestratorAgent) nem afeta o modelo rápido/STT/TTS.
// Centralizado aqui para não repetir a injeção em cada um dos ~7 agentes.
function applyEffortWrapper(client) {
    if (!PRINCIPAL_REASONING_EFFORT) return client;
    const _create = client.responses.create.bind(client.responses);
    client.responses.create = (body, options) => {
        if (body && body.model === PRINCIPAL_REASONING_MODEL && !body.reasoning) {
            body = { ...body, reasoning: { effort: PRINCIPAL_REASONING_EFFORT } };
        }
        return _create(body, options);
    };
    return client;
}

// Cliente de produção — sempre disponível.
export const openai = applyEffortWrapper(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

// Cliente de benchmark — memoizado e lazy (o boot de produção não exige a chave).
let _benchmarkClient = null;
export function openaiBenchmark() {
    if (_benchmarkClient) return _benchmarkClient;
    if (!process.env.OPENAI_API_KEY_BENCHMARK) {
        throw new Error("OPENAI_API_KEY_BENCHMARK ausente — trabalhos de benchmark usam chave própria para separar o gasto; defina-a no .env");
    }
    _benchmarkClient = applyEffortWrapper(new OpenAI({ apiKey: process.env.OPENAI_API_KEY_BENCHMARK }));
    return _benchmarkClient;
}

// True se o work deve ser roteado pela chave de benchmark.
export function isBenchmarkWork(work) {
    return !!(work && work.is_benchmark);
}

// Cliente OpenAI apropriado ao work (benchmark ou produção).
export function clientForWork(work) {
    return isBenchmarkWork(work) ? openaiBenchmark() : openai;
}

// String da API key apropriada ao work — para os call-sites que falam com a
// OpenAI SEM o SDK (WebSocket do Realtime, mint de client_secret efêmero).
// Fail-fast igual ao cliente: um work de benchmark sem a chave é erro, não
// fallback silencioso para produção.
export function apiKeyForWork(work) {
    if (isBenchmarkWork(work)) {
        if (!process.env.OPENAI_API_KEY_BENCHMARK) {
            throw new Error("OPENAI_API_KEY_BENCHMARK ausente — trabalho de benchmark exige a chave dedicada; defina-a no .env");
        }
        return process.env.OPENAI_API_KEY_BENCHMARK;
    }
    return process.env.OPENAI_API_KEY;
}

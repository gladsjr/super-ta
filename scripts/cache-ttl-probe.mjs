// Sonda do TTL do cache de prompt da OpenAI (gpt-5.6-terra), na chave de benchmark.
//
// Pergunta que responde: "quanto tempo o cache de prompt sobrevive entre chamadas?"
// — crítico para saber se a DEMORA de um aluno real entre turnos derruba o cache
// (e encarece o custo real) em relação ao driver rápido.
//
// Método: para cada atraso d, monta um prompt GRANDE e único (~15k tokens), dispara
// a chamada 1 (aquece o cache), espera d segundos, dispara a chamada 2 com o MESMO
// prompt e mede quanto do input veio cacheado. cache alto na 2ª = cache sobreviveu.
//
// Uso: node -r dotenv/config scripts/cache-ttl-probe.mjs [--delays 0,60,180,300,600]

import "dotenv/config";
import { openaiBenchmark } from "../lib/openaiClient.js";
import { PRINCIPAL_REASONING_MODEL } from "../lib/config.js";

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

function parseDelays(argv) {
    const i = argv.indexOf("--delays");
    if (i >= 0 && argv[i + 1]) return argv[i + 1].split(",").map(Number).filter(n => Number.isFinite(n));
    return [0, 60, 180, 300, 600];
}

// Prefixo grande e ESTÁVEL (cacheável). ~15k tokens de texto plausível repetido,
// para bater a ordem de grandeza do prompt do orquestrador da entrevista.
function bigPrefix(salt) {
    const para = "Este é um bloco de contexto estável usado para medir o cache de prompt. " +
        "Ele descreve o cenário de uma entrevista de arguição oral sobre um trabalho acadêmico ou profissional, " +
        "com premissas, números, seções e critérios de avaliação que se repetem a cada turno da conversa. ";
    let s = `[PROBE ${salt}] `;
    while (s.length < 60000) s += para; // ~60k chars ≈ ~15k tokens
    return s;
}

async function probe(model, delay) {
    const client = openaiBenchmark();
    const key = `ttlprobe-${delay}`;
    const prefix = bigPrefix(delay); // único por delay → testes independentes
    const mk = (q) => ({
        model,
        input: `${prefix}\n\nPergunta: ${q}`,
        prompt_cache_key: key,
        max_output_tokens: 16,
        reasoning: { effort: "low" }, // explícito → o wrapper de effort não sobrescreve; barato (gpt-5.6-terra não aceita 'minimal')
    });
    // Chamada 1: aquece.
    await client.responses.create(mk("Responda apenas OK."));
    if (delay > 0) await sleep(delay);
    // Chamada 2: mede o cache.
    const r2 = await client.responses.create(mk("Responda apenas OK de novo."));
    const u = r2.usage || {};
    const input = Number(u.input_tokens || 0);
    const cached = Number(u.input_tokens_details?.cached_tokens || 0);
    return { delay, input, cached, pct: input ? Math.round(100 * cached / input) : 0 };
}

async function main() {
    const model = PRINCIPAL_REASONING_MODEL;
    const delays = parseDelays(process.argv.slice(2));
    console.log(`=== Sonda de TTL do cache — modelo ${model} — atrasos: ${delays.join(", ")}s ===`);
    for (const d of delays) {
        try {
            const r = await probe(model, d);
            console.log(`atraso=${String(d).padStart(4)}s  →  cache na 2ª chamada: ${r.cached}/${r.input} tokens (${r.pct}%)`);
        } catch (e) {
            console.log(`atraso=${d}s  →  ERRO: ${e.message}`);
        }
    }
    console.log("\nLeitura: cache alto = sobreviveu ao atraso. O atraso onde o cache DESPENCA é o TTL efetivo.");
    process.exit(0);
}

main().catch(e => { console.error("ERRO:", e.message); process.exit(1); });

// Camada de provedor STT (#284): plano de tentativas, fallback, timeout,
// sombra e o WER de comparação. Motores injetados — nada de rede.
//
//   node --test tests/stt-provider.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptPlan, effectiveTimeoutMs, simpleWer, transcribe } from "../lib/sttProvider.js";

const CFG = (over = {}) => ({
    provider: "openai", fallbackProvider: null, sttModel: "gpt-transcribe",
    groqModel: "whisper-large-v3", timeoutMs: 0, shadowProvider: null, shadowRate: 0,
    ...over,
});
const CALL = { openaiClient: {}, buffer: Buffer.from("x"), filename: "a.webm", keywords: null };
const okEngine = (provider) => async () => ({ text: `oi de ${provider}`, usage: undefined, logprobs: null, quality: null, provider, model: "m" });
const failEngine = (msg) => async () => { throw new Error(msg); };

test("plano: sem fallback = 1 tentativa; fallback igual ao primário é ignorado", () => {
    assert.deepEqual(attemptPlan({ provider: "openai", fallbackProvider: null }), ["openai"]);
    assert.deepEqual(attemptPlan({ provider: "groq", fallbackProvider: "openai" }), ["groq", "openai"]);
    assert.deepEqual(attemptPlan({ provider: "openai", fallbackProvider: "openai" }), ["openai"]);
});

test("timeout só existe quando há para onde cair (histórico preservado)", () => {
    assert.equal(effectiveTimeoutMs({ plan: ["openai"], timeoutMs: 15000 }), null);
    assert.equal(effectiveTimeoutMs({ plan: ["groq", "openai"], timeoutMs: 15000 }), 15000);
    assert.equal(effectiveTimeoutMs({ plan: ["groq", "openai"], timeoutMs: 0 }), null);
});

test("caminho feliz: config padrão usa o openai e devolve o texto", async () => {
    const r = await transcribe(CFG(), CALL, { openai: okEngine("openai") });
    assert.equal(r.text, "oi de openai");
    assert.equal(r.provider, "openai");
});

test("fallback: primário falha → secundário responde", async () => {
    const r = await transcribe(
        CFG({ provider: "groq", fallbackProvider: "openai" }), CALL,
        { groq: failEngine("groq caiu"), openai: okEngine("openai") },
    );
    assert.equal(r.provider, "openai");
});

test("fallback: timeout do primário também cai para o secundário", async () => {
    const lento = () => new Promise(res => setTimeout(() => res({ text: "tarde", provider: "groq" }), 300));
    const r = await transcribe(
        CFG({ provider: "groq", fallbackProvider: "openai", timeoutMs: 50 }), CALL,
        { groq: lento, openai: okEngine("openai") },
    );
    assert.equal(r.provider, "openai");
});

test("sem fallback, a falha do primário propaga (fail-fast)", async () => {
    await assert.rejects(
        () => transcribe(CFG(), CALL, { openai: failEngine("api fora") }),
        /api fora/,
    );
});

test("os dois falham → propaga o último erro", async () => {
    await assert.rejects(
        () => transcribe(
            CFG({ provider: "groq", fallbackProvider: "openai" }), CALL,
            { groq: failEngine("groq caiu"), openai: failEngine("openai caiu") },
        ),
        /openai caiu/,
    );
});

test("sombra nunca altera o resultado, mesmo quando falha", async () => {
    const r = await transcribe(
        CFG({ shadowProvider: "groq", shadowRate: 1 }), CALL,
        { openai: okEngine("openai"), groq: failEngine("sombra caiu") },
    );
    assert.equal(r.text, "oi de openai");
    await new Promise(res => setTimeout(res, 20)); // deixa a sombra assíncrona morrer em paz
});

test("simpleWer: idêntico=0, tudo errado=1, tolerante a pontuação/caixa", () => {
    assert.equal(simpleWer("o gato subiu", "O gato, subiu!"), 0);
    assert.equal(simpleWer("um dois três", "quatro cinco seis"), 1);
    assert.equal(simpleWer("", ""), 0);
    const w = simpleWer("câmbio on-chain é a saída", "cambium chain é a saída");
    assert.ok(w > 0 && w < 1, `wer parcial esperado, veio ${w}`);
});

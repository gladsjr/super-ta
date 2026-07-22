// Testa a MATEMÁTICA pura da reconciliação de custo (lib/costAudit.js): agrega
// o lado calculado (work_cost_events), aplica pricing.yaml sobre o uso real
// (Usage API) e computa os deltas. Sem rede, sem DB — só as funções puras +
// loadPricing() lendo config/pricing.yaml.
//
// Rodar: node --test tests/cost-audit.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPricing } from "../lib/billing.js";
import {
    summarizeCalculated,
    summarizeUsage,
    referenceUsdForUsage,
    referenceUsdTotal,
    computeTokenDeltas,
    buildReconciliation,
} from "../lib/costAudit.js";

const pricing = loadPricing();

test("summarizeCalculated soma custo e tokens por modelo", () => {
    const rows = [
        { model: "gpt-5.6-terra", event_type: "responses", input_tokens: 1000, cached_tokens: 200, output_tokens: 300, audio_seconds: 0, audio_chars: 0, cost_usd: 0.01 },
        { model: "gpt-5.6-terra", event_type: "responses", input_tokens: 500, cached_tokens: 0, output_tokens: 100, audio_seconds: 0, audio_chars: 0, cost_usd: 0.02 },
        { model: "gpt-4o-mini-tts", event_type: "tts", input_tokens: 0, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, audio_chars: 1200, cost_usd: 0.03 },
    ];
    const { calculatedUsd, byModel } = summarizeCalculated(rows);
    assert.equal(Math.round(calculatedUsd * 1e6), Math.round(0.06 * 1e6));
    assert.equal(byModel["gpt-5.6-terra"].input_tokens, 1500);
    assert.equal(byModel["gpt-5.6-terra"].cached_tokens, 200);
    assert.equal(byModel["gpt-5.6-terra"].output_tokens, 400);
    assert.equal(byModel["gpt-4o-mini-tts"].audio_chars, 1200);
});

test("referenceUsdForUsage: completions usa preço de texto (billable = input − cached)", () => {
    const line = { category: "completions", model: "gpt-5.6-terra", input_tokens: 1_000_000, cached_tokens: 200_000, output_tokens: 1_000_000, audio_seconds: 0, characters: 0 };
    // billable = 800k → 800000*2.5/1e6 = 2.0 ; cached 200k*0.25/1e6 = 0.05 ; out 1M*15/1e6 = 15.0
    const { usd, priced } = referenceUsdForUsage(line, pricing);
    assert.equal(priced, true);
    assert.equal(Math.round(usd * 1e6) / 1e6, 17.05);
});

test("referenceUsdForUsage: TTS por caractere; STT por segundo", () => {
    const tts = referenceUsdForUsage({ category: "audio_speeches", model: "gpt-4o-mini-tts", characters: 1_000_000, input_tokens: 0, cached_tokens: 0, output_tokens: 0, audio_seconds: 0 }, pricing);
    assert.equal(tts.priced, true);
    assert.equal(tts.usd, 25.0); // 1M chars * 25/Mchar

    const stt = referenceUsdForUsage({ category: "audio_transcriptions", model: "gpt-4o-transcribe", audio_seconds: 100, input_tokens: 0, cached_tokens: 0, output_tokens: 0, characters: 0 }, pricing);
    assert.equal(stt.priced, true);
    assert.equal(Math.round(stt.usd * 1e6) / 1e6, 0.6); // 100s * 0.006
});

test("referenceUsdForUsage: modelo sem preço → priced=false, usd=0", () => {
    const r = referenceUsdForUsage({ category: "completions", model: "modelo-inexistente", input_tokens: 100, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 }, pricing);
    assert.equal(r.priced, false);
    assert.equal(r.usd, 0);
});

test("referenceUsdTotal soma e reporta os não-precificados", () => {
    const lines = [
        { category: "completions", model: "gpt-5.6-terra", input_tokens: 1_000_000, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 }, // 2.5
        { category: "completions", model: "desconhecido", input_tokens: 500, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 },
    ];
    const { referenceUsd, unpriced } = referenceUsdTotal(lines, pricing);
    assert.equal(referenceUsd, 2.5);
    assert.deepEqual(unpriced, ["completions:desconhecido"]);
});

test("computeTokenDeltas: real − calculado por modelo", () => {
    const calc = { "gpt-5.6-terra": { input_tokens: 1000, cached_tokens: 100, output_tokens: 300, audio_seconds: 0, audio_chars: 0 } };
    const usage = { "gpt-5.6-terra": { input_tokens: 1100, cached_tokens: 120, output_tokens: 280, audio_seconds: 0, characters: 0 } };
    const d = computeTokenDeltas(calc, usage);
    assert.equal(d["gpt-5.6-terra"].input_tokens, 100);
    assert.equal(d["gpt-5.6-terra"].cached_tokens, 20);
    assert.equal(d["gpt-5.6-terra"].output_tokens, -20);
    assert.equal(d["gpt-5.6-terra"].actual.input, 1100);
    assert.equal(d["gpt-5.6-terra"].calculated.output, 300);
});

test("buildReconciliation: junta os lados, calcula deltaUsd e deltaPct", () => {
    // Calculado: 1 chamada de texto que custou $2.00 localmente.
    const calculatedRows = [
        { model: "gpt-5.6-terra", event_type: "responses", input_tokens: 800_000, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, audio_chars: 0, cost_usd: 2.0 },
    ];
    // Real (Usage): 1M input não-cacheado no mesmo modelo → referência 2.5.
    const usageLines = [
        { category: "completions", model: "gpt-5.6-terra", input_tokens: 1_000_000, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 },
    ];
    const recon = buildReconciliation({
        benchmarkRunId: "bench-x", windowStart: "2026-07-21T00:00:00Z", windowEnd: "2026-07-21T01:00:00Z",
        calculatedRows, usageLines, projectCosts: { total_usd: 9.99 }, notes: [],
    });
    assert.equal(recon.calculatedUsd, 2.0);
    assert.equal(recon.referenceUsd, 2.5);
    assert.equal(Math.round(recon.deltaUsd * 1e6) / 1e6, 0.5);
    assert.equal(Math.round(recon.deltaPct * 100) / 100, 25.0); // 0.5/2.0 = 25%
    assert.equal(recon.costsApiProjectUsd, 9.99);
    assert.equal(recon.status, "pending");
    assert.equal(recon.benchmarkRunId, "bench-x");
});

test("buildReconciliation: sem uso real → referência/deltas nulos (não força 0)", () => {
    const recon = buildReconciliation({
        benchmarkRunId: null, windowStart: "2026-07-21T00:00:00Z", windowEnd: "2026-07-21T01:00:00Z",
        calculatedRows: [{ model: "gpt-5.6-terra", event_type: "responses", input_tokens: 10, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, audio_chars: 0, cost_usd: 1.0 }],
        usageLines: [], projectCosts: null, notes: ["sem admin key"],
    });
    assert.equal(recon.referenceUsd, null);
    assert.equal(recon.deltaUsd, null);
    assert.equal(recon.deltaPct, null);
    assert.equal(recon.actualUsageTokensJson, null);
    assert.match(recon.note, /sem admin key/);
});

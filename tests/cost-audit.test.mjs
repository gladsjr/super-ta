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

// Os valores esperados dos casos de preço são DERIVADOS do config/pricing.yaml,
// nunca cravados aqui. Motivo: o que este arquivo protege é a FÓRMULA (quais
// tokens entram em qual tarifa), não a tabela vigente. Quando as expectativas
// eram números fixos, o corte de preço do terra (−20%, 30/07/2026) quebrou três
// casos de uma vez sem que nada no código estivesse errado — ruído de manutenção
// que se repetiria a cada reajuste. Derivando, um reajuste futuro passa limpo e
// só um erro de conta faz o teste falhar.
const MODELO_TEXTO = "gpt-5.6-terra";
const MODELO_TTS = "gpt-4o-mini-tts";
const MODELO_STT = "gpt-4o-transcribe";

const precoTexto = pricing.text?.[MODELO_TEXTO];
const precoTts = pricing.tts?.[MODELO_TTS];
const precoStt = pricing.stt?.[MODELO_STT];

// Guarda: se um desses modelos sair do pricing.yaml, a falha tem que dizer isso
// em vez de aparecer como uma conta errada em quatro casos diferentes.
assert.ok(precoTexto, `config/pricing.yaml sem text.${MODELO_TEXTO} — troque o modelo usado nestes testes`);
assert.ok(precoTts, `config/pricing.yaml sem tts.${MODELO_TTS} — troque o modelo usado nestes testes`);
assert.ok(precoStt, `config/pricing.yaml sem stt.${MODELO_STT} — troque o modelo usado nestes testes`);

// Arredonda ao milionésimo de dólar para comparar sem ruído de ponto flutuante.
const usd6 = (x) => Math.round(x * 1e6) / 1e6;

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
    const line = { category: "completions", model: MODELO_TEXTO, input_tokens: 1_000_000, cached_tokens: 200_000, output_tokens: 1_000_000, audio_seconds: 0, characters: 0 };
    // O que se verifica: input cacheado sai da conta do preço cheio (billable =
    // 1M − 200k) e é cobrado à tarifa de cache; output vai à tarifa de saída.
    const esperado = (
        800_000 * precoTexto.input_per_mtok +
        200_000 * precoTexto.input_cached_per_mtok +
        1_000_000 * precoTexto.output_per_mtok
    ) / 1e6;
    const { usd, priced } = referenceUsdForUsage(line, pricing);
    assert.equal(priced, true);
    assert.equal(usd6(usd), usd6(esperado));
});

test("referenceUsdForUsage: TTS por caractere; STT por segundo", () => {
    // TTS: 1M chars → exatamente a tarifa por milhão de caracteres.
    const tts = referenceUsdForUsage({ category: "audio_speeches", model: MODELO_TTS, characters: 1_000_000, input_tokens: 0, cached_tokens: 0, output_tokens: 0, audio_seconds: 0 }, pricing);
    assert.equal(tts.priced, true);
    assert.equal(usd6(tts.usd), usd6(precoTts.text_per_mchar));

    // STT sem tokens no usage: cai na tarifa por segundo (100s).
    const stt = referenceUsdForUsage({ category: "audio_transcriptions", model: MODELO_STT, audio_seconds: 100, input_tokens: 0, cached_tokens: 0, output_tokens: 0, characters: 0 }, pricing);
    assert.equal(stt.priced, true);
    assert.equal(usd6(stt.usd), usd6(100 * precoStt.per_second_usd));
});

test("referenceUsdForUsage: modelo sem preço → priced=false, usd=0", () => {
    const r = referenceUsdForUsage({ category: "completions", model: "modelo-inexistente", input_tokens: 100, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 }, pricing);
    assert.equal(r.priced, false);
    assert.equal(r.usd, 0);
});

test("referenceUsdTotal soma e reporta os não-precificados", () => {
    const lines = [
        // 1M de input não-cacheado → a referência é exatamente input_per_mtok.
        { category: "completions", model: MODELO_TEXTO, input_tokens: 1_000_000, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 },
        { category: "completions", model: "desconhecido", input_tokens: 500, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 },
    ];
    const { referenceUsd, unpriced } = referenceUsdTotal(lines, pricing);
    // A linha sem preço soma zero, não derruba nem infla o total.
    assert.equal(usd6(referenceUsd), usd6(precoTexto.input_per_mtok));
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
    // Real (Usage): 1M input não-cacheado → referência = input_per_mtok.
    const usageLines = [
        { category: "completions", model: MODELO_TEXTO, input_tokens: 1_000_000, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0 },
    ];
    const referenciaEsperada = precoTexto.input_per_mtok;
    // O custo CALCULADO localmente é arbitrado em 80% da referência para que o
    // delta seja sempre +25%, qualquer que seja a tabela de preços. Derivar os
    // dois lados do MESMO preço zeraria o delta — e delta zero não prova nada
    // sobre a subtração nem sobre o percentual, que é justamente o que este caso
    // existe para proteger.
    const calculadoUsd = referenciaEsperada * 0.8;
    const calculatedRows = [
        { model: MODELO_TEXTO, event_type: "responses", input_tokens: 800_000, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, audio_chars: 0, cost_usd: calculadoUsd },
    ];
    const recon = buildReconciliation({
        benchmarkRunId: "bench-x", windowStart: "2026-07-21T00:00:00Z", windowEnd: "2026-07-21T01:00:00Z",
        calculatedRows, usageLines, projectCosts: { total_usd: 9.99 }, notes: [],
    });
    assert.equal(usd6(recon.calculatedUsd), usd6(calculadoUsd));
    assert.equal(usd6(recon.referenceUsd), usd6(referenciaEsperada));
    assert.equal(usd6(recon.deltaUsd), usd6(referenciaEsperada - calculadoUsd));
    assert.equal(Math.round(recon.deltaPct * 100) / 100, 25.0); // (ref − calc)/calc
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

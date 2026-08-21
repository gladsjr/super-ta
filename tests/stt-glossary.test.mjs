// Glossário mecânico de domínio para o STT (#293). Extração pura, sem LLM.
//
//   node --test tests/stt-glossary.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGlossary, glossaryForSession } from "../lib/sttGlossary.js";

test("siglas e marcas com ≥2 maiúsculas entram (o alvo clássico da corrupção)", () => {
    const g = extractGlossary([
        "Como o USDC mantém o peg? E a DAI? O TVL caiu segundo a MiCA?",
        "O GENIUS Act exige lastro. A BRZ opera câmbio on-chain via DeFi.",
    ]);
    for (const t of ["USDC", "DAI", "TVL", "MiCA", "BRZ", "DeFi"]) {
        assert.ok(g.includes(t), `faltou ${t} em ${g}`);
    }
});

test("bigramas capitalizados entram (GENIUS Act, Santa Clara)", () => {
    const g = extractGlossary(["O GENIUS Act regula. A Santa Clara atesta as vacas."]);
    assert.ok(g.includes("GENIUS Act"), String(g));
    assert.ok(g.includes("Santa Clara"), String(g));
});

test("hifenizados de domínio entram (on-chain, e-FX)", () => {
    const g = extractGlossary(["A liquidação on-chain depende da regra de e-FX do Banco Central."]);
    assert.ok(g.includes("on-chain"), String(g));
    assert.ok(g.includes("e-FX"), String(g));
});

test("antiviés: números NUNCA entram; stopwords all-caps ficam de fora", () => {
    const g = extractGlossary(["O resgate de 84 milhões em 2022. OK? O PDF da FGV diz US$ 12."]);
    assert.ok(!g.some(t => /^\d+$/.test(t)), String(g));
    for (const s of ["OK", "PDF", "FGV", "US"]) assert.ok(!g.includes(s), `${s} não devia entrar`);
});

test("dedup por caixa, ordenação por frequência e teto", () => {
    const g = extractGlossary(["USDC usdc USDC e DAI"], { max: 1 });
    assert.deepEqual(g, ["USDC"]); // mais frequente vence; forma original preservada
});

test("glossaryForSession: monta do plano+análise, memoiza, e null sem insumo", () => {
    const sess = {
        interviewPlan: { questions: [{ question: "Explique o papel do USDC no PSM da DAI." }, "E o GENIUS Act?"] },
        workAnalysis: { summary: "Estudo sobre stablecoins e MiCA.", critical_points: ["Confusão sobre TVL"] },
    };
    const g = glossaryForSession(sess, { workName: "FGV MBA Stablecoin" });
    for (const t of ["USDC", "PSM", "DAI", "GENIUS Act", "MiCA", "TVL"]) assert.ok(g.includes(t), `faltou ${t}`);
    assert.equal(glossaryForSession(sess), g, "memoizado em sess.sttGlossary");
    const vazio = {};
    assert.equal(glossaryForSession(vazio), null, "sem insumo → null (caller não passa keywords)");
    assert.equal(vazio.sttGlossary, null, "memoiza o null também");
});

// Janela ociosa do executor de jobs (#289, corte 3) — a regra pura que decide
// se o motor LOCAL pode rodar. O resto do executor (claim/lease/retry) é SQL e
// se valida contra banco real (ver PR do corte 3); aqui fica o que é lógica.
import test from "node:test";
import assert from "node:assert/strict";

// O jobRunner puxa a cadeia openaiClient→OpenAI, que exige chave no load do
// módulo; para testar a função PURA basta uma chave fictícia antes do import.
process.env.OPENAI_API_KEY ||= "sk-test-janela";
const { localWindowOpen } = await import("../lib/jobRunner.js");

test("janela do motor local", async (t) => {
    await t.test("abre com zero sessões e memória folgada", () => {
        assert.equal(localWindowOpen({ activeSessions: 0, freeMb: 1500, minFreeMb: 700 }), true);
    });

    await t.test("fecha com QUALQUER sessão de voz ativa", () => {
        assert.equal(localWindowOpen({ activeSessions: 1, freeMb: 4000, minFreeMb: 700 }), false);
    });

    await t.test("fecha com memória abaixo do piso, mesmo sem sessão", () => {
        assert.equal(localWindowOpen({ activeSessions: 0, freeMb: 500, minFreeMb: 700 }), false);
    });

    await t.test("piso é inclusivo (freeMb == minFreeMb abre)", () => {
        assert.equal(localWindowOpen({ activeSessions: 0, freeMb: 700, minFreeMb: 700 }), true);
    });

    await t.test("piso zero = só a regra de sessões", () => {
        assert.equal(localWindowOpen({ activeSessions: 0, freeMb: 0, minFreeMb: 0 }), true);
        assert.equal(localWindowOpen({ activeSessions: 2, freeMb: 0, minFreeMb: 0 }), false);
    });
});

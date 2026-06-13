// Teste unitário do streaming-parse do super-orquestrador (sem API).
// Cobre os casos de borda do extractor que dispara o TTS cedo: escapes,
// truncamento, ordem dos campos, kind inválido. Rode: node tests/unit-streaming-parse.mjs
import assert from "node:assert";
import { extractJsonStringValue, extractReadyAction } from "../lib/superOrchestrator/actionSchema.js";

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); passed++; console.log(`ok   ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// JSON completo na ordem nova (action → rationale → memory)
t("JSON completo: extrai kind+message", () => {
    const full = '{"action":{"kind":"follow_up","message":"Entendi, Bruno. E os R$ 45 mil?","about_turn_index":3},"rationale":"x","memory":{}}';
    assert.deepStrictEqual(extractReadyAction(full), { kind: "follow_up", message: "Entendi, Bruno. E os R$ 45 mil?" });
});

// O caso do ganho: message já fechou, rationale/memory ainda não vieram → dispara
t("message fechada antes do rationale → dispara", () => {
    const partial = '{"action":{"kind":"ask","message":"Vamos começar. Conta da seção 3.","plan_question_id":2';
    assert.deepStrictEqual(extractReadyAction(partial), { kind: "ask", message: "Vamos começar. Conta da seção 3." });
});

// message ainda aberta → não dispara
t("message aberta → não dispara", () => {
    assert.strictEqual(extractReadyAction('{"action":{"kind":"ask","message":"Vamos começar. Na seção 3 você'), null);
});

// kind sem message ainda → não dispara
t("kind sem message → não dispara", () => {
    assert.strictEqual(extractReadyAction('{"action":{"kind":"ask",'), null);
});

// aspas escapadas dentro da fala
t("aspas escapadas", () => {
    const esc = '{"action":{"kind":"hint","message":"Ele disse \\"não sei\\" e parou."},"rationale":"x"}';
    assert.deepStrictEqual(extractReadyAction(esc), { kind: "hint", message: 'Ele disse "não sei" e parou.' });
});

// quebras de linha escapadas
t("newline escapado", () => {
    assert.deepStrictEqual(extractReadyAction('{"action":{"kind":"ask","message":"Linha 1.\\nLinha 2."}}'),
        { kind: "ask", message: "Linha 1.\nLinha 2." });
});

// unicode escapado (\uXXXX)
t("unicode escapado", () => {
    assert.deepStrictEqual(extractReadyAction('{"action":{"kind":"ask","message":"Caf\\u00e9 da manh\\u00e3?"}}'),
        { kind: "ask", message: "Café da manhã?" });
});

// kind inválido → não dispara
t("kind inválido → não dispara", () => {
    assert.strictEqual(extractReadyAction('{"action":{"kind":"bogus","message":"oi"}}'), null);
});

// rationale contendo a palavra "message" não confunde (action vem primeiro)
t("rationale com 'message' não confunde", () => {
    const tricky = '{"action":{"kind":"ask","message":"Pergunta real."},"rationale":"a message anterior era vaga"}';
    assert.deepStrictEqual(extractReadyAction(tricky), { kind: "ask", message: "Pergunta real." });
});

// truncado no meio de um escape → não quebra, não dispara
t("truncado no escape → não quebra", () => {
    assert.strictEqual(extractReadyAction('{"action":{"kind":"ask","message":"oi \\'), null);
});

// extractJsonStringValue: flag complete
t("extractJsonStringValue: string aberta → complete=false", () => {
    assert.deepStrictEqual(extractJsonStringValue('{"message":"abc', "message"), { value: "abc", complete: false });
});
t("extractJsonStringValue: chave ausente → null", () => {
    assert.strictEqual(extractJsonStringValue('{"foo":"bar"}', "message"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

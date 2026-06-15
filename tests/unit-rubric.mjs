// Teste unitário dos helpers PUROS da rubrica de notas (sem LLM, sem banco).
// Cobre a média ponderada e a validação/normalização de forma.
// Rode: node tests/unit-rubric.mjs
import assert from "node:assert";
import {
    validateRubricShape,
    weightedFinal,
    parseStoredRubric,
    getEffectiveRubric,
    DEFAULT_RUBRIC,
} from "../lib/rubric.js";

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); passed++; console.log(`ok   ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// ---- weightedFinal ----
t("pesos iguais: média simples", () => {
    assert.strictEqual(weightedFinal([{ weight: 1, score: 8 }, { weight: 1, score: 6 }]), 7);
});
t("pesos diferentes: média ponderada", () => {
    assert.strictEqual(weightedFinal([{ weight: 30, score: 10 }, { weight: 40, score: 5 }, { weight: 30, score: 0 }]), 5);
});
t("arredonda a 1 casa", () => {
    assert.strictEqual(weightedFinal([{ weight: 1, score: 8 }, { weight: 1, score: 7 }, { weight: 1, score: 7 }]), 7.3);
});
t("ignora item sem nota numérica", () => {
    assert.strictEqual(weightedFinal([{ weight: 1, score: 8 }, { weight: 1 }]), 8);
});
t("sem peso válido → null", () => {
    assert.strictEqual(weightedFinal([]), null);
    assert.strictEqual(weightedFinal([{ weight: 0, score: 9 }]), null);
});

// ---- validateRubricShape ----
t("rejeita vazio", () => {
    assert.throws(() => validateRubricShape([]), /ao menos um critério/);
    assert.throws(() => validateRubricShape(null), /ao menos um critério/);
});
t("rejeita nome vazio", () => {
    assert.throws(() => validateRubricShape([{ name: "  ", weight: 1, prompt: "x" }]), /nome obrigatório/);
});
t("rejeita prompt vazio", () => {
    assert.throws(() => validateRubricShape([{ name: "A", weight: 1, prompt: "" }]), /prompt obrigatório/);
});
t("rejeita peso <= 0 ou não numérico", () => {
    assert.throws(() => validateRubricShape([{ name: "A", weight: 0, prompt: "p" }]), /peso/);
    assert.throws(() => validateRubricShape([{ name: "A", weight: "x", prompt: "p" }]), /peso/);
});
t("normaliza: trim, peso numérico, id garantido", () => {
    const out = validateRubricShape([{ name: " Clareza ", weight: "2", prompt: " p " }]);
    assert.strictEqual(out[0].name, "Clareza");
    assert.strictEqual(out[0].weight, 2);
    assert.strictEqual(out[0].prompt, "p");
    assert.ok(out[0].id && typeof out[0].id === "string");
});
t("desduplica ids", () => {
    const out = validateRubricShape([
        { id: "x", name: "A", weight: 1, prompt: "p" },
        { id: "x", name: "B", weight: 1, prompt: "q" },
    ]);
    assert.notStrictEqual(out[0].id, out[1].id);
});

// ---- parseStoredRubric / getEffectiveRubric ----
t("parseStoredRubric: null/ilegível → null", () => {
    assert.strictEqual(parseStoredRubric(null), null);
    assert.strictEqual(parseStoredRubric("{bad"), null);
    assert.strictEqual(parseStoredRubric('{"criteria":[]}'), null);
});
t("parseStoredRubric: extrai criteria", () => {
    const r = parseStoredRubric('{"criteria":[{"id":"x","name":"A","weight":1,"prompt":"p"}]}');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].name, "A");
});
t("getEffectiveRubric: null → DEFAULT_RUBRIC", () => {
    assert.strictEqual(getEffectiveRubric({ grading_rubric: null }), DEFAULT_RUBRIC);
    assert.strictEqual(getEffectiveRubric({}).length, DEFAULT_RUBRIC.length);
});
t("getEffectiveRubric: custom é respeitado", () => {
    const custom = [{ id: "x", name: "N", weight: 1, prompt: "p" }];
    assert.strictEqual(getEffectiveRubric({ grading_rubric: custom }), custom);
});
t("DEFAULT_RUBRIC: 2 critérios de peso igual", () => {
    assert.strictEqual(DEFAULT_RUBRIC.length, 2);
    assert.strictEqual(DEFAULT_RUBRIC[0].weight, DEFAULT_RUBRIC[1].weight);
    assert.ok(DEFAULT_RUBRIC.every(c => c.name && c.prompt && c.id));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

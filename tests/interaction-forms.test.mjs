// Testes das FORMAS de interação (puro — sem LLM, sem banco).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMS, FORM_DEFAULT_WORK, formKind, normalizeForm, formDynamics } from "../lib/scenarios/interactionForms.js";

test("formKind: deliberacao => persona_exchange; demais => student", () => {
    assert.equal(formKind("deliberacao"), "persona_exchange");
    for (const f of FORMS) if (f !== "deliberacao") assert.equal(formKind(f), "student");
});

test("normalizeForm: compat objective_type/kind => form", () => {
    assert.equal(normalizeForm({ form: "feedback" }), "feedback");          // forma explícita ganha
    assert.equal(normalizeForm({ kind: "persona_exchange" }), "deliberacao");
    assert.equal(normalizeForm({ objective_type: "diagnostico" }), "consultoria");
    assert.equal(normalizeForm({ objective_type: "apresentacao" }), "apresentacao");
    assert.equal(normalizeForm({}), "arguicao");                            // fallback
});

test("default de incluir trabalho do aluno por forma", () => {
    assert.equal(FORM_DEFAULT_WORK.apresentacao, true);
    assert.equal(FORM_DEFAULT_WORK.arguicao, true);
    assert.equal(FORM_DEFAULT_WORK.consultoria, false);
});

test("formDynamics: texto para formas student-facing; custom vazio", () => {
    for (const f of ["apresentacao", "arguicao", "feedback", "consultoria", "negociacao", "discussao"]) {
        assert.ok(formDynamics(f).length > 20, `dinâmica de ${f}`);
    }
    assert.equal(formDynamics("custom"), "");
});

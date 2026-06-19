// Testes do conversor YAML de cenário/persona (puro — sem LLM, sem banco).
// node --test tests/scenario-yaml.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarioToYaml, personaToYaml, parseYaml } from "../lib/scenarios/scenarioYaml.js";
import { interviewerPersonaTemplates } from "../lib/scenarios/importInterviewerPersonas.js";

const persona = (name, extra = {}) => ({
    id: "cp_" + name.toLowerCase(), name, icon: "🧑", role: `papel de ${name}`,
    gender: "feminino", voice: "nova", tone: "direto", description: "d", authority: "a",
    objectives: ["o1", "o2"], concerns: ["c1"], decision_criteria: ["dc1"], constraints: [],
    information_needs: ["in1"], evaluation_mode: ["em1"],
    knowledge: { scope: ["s1"], assets: [{ type: "document", label: "doc" }], level: "alto" },
    example_questions: ["q1?"], ...extra,
});

const SCEN = {
    name: "Banca", description: "desc geral",
    personas: [persona("Marcos"), persona("Ana")],
    interactions: [
        { id: "i1", title: "Abertura", kind: "student", objective_type: "apresentacao", participants: [{ persona_id: "cp_marcos", role: "entrevista" }], instruction: "abra", example_questions: ["x?"] },
        { id: "i2", title: "Deliberação", kind: "persona_exchange", objective_type: "negociacao", participants: [{ persona_id: "cp_marcos" }, { persona_id: "cp_ana" }], focus: "vale a pena?" },
    ],
};

test("round-trip do cenário é idempotente (ids ficam fora do YAML)", () => {
    const y1 = scenarioToYaml(SCEN);
    const back = parseYaml(y1);
    assert.equal(back.kind, "scenario");
    assert.equal(back.scenario.personas.length, 2);
    assert.equal(back.scenario.interactions.length, 2);
    assert.equal(scenarioToYaml(back.scenario), y1, "dois passes produzem o mesmo YAML");
});

test("round-trip da persona é idempotente", () => {
    const y1 = personaToYaml(persona("Helena"));
    const back = parseYaml(y1);
    assert.equal(back.kind, "persona");
    assert.equal(personaToYaml(back.persona), y1);
});

test("detecção de granularidade (cenário vs persona)", () => {
    assert.equal(parseYaml(scenarioToYaml(SCEN)).kind, "scenario");
    assert.equal(parseYaml(personaToYaml(persona("X"))).kind, "persona");
});

test("erros amigáveis: YAML solto e referência de persona inexistente", () => {
    assert.throws(() => parseYaml("apenas um texto solto"), /inesperado|inválido|vazio/i);
    const badRef = `name: S
interactions:
  - title: T
    kind: student
    participants:
      - persona: Fulano
        role: entrevista`;
    assert.throws(() => parseYaml(badRef), /não está nas personas|não encontrada/i);
});

test("import das 6 personas da entrevista", () => {
    const t = interviewerPersonaTemplates();
    assert.equal(t.length, 6, "6 YAMLs em config/interviewers/");
    for (const p of t) {
        assert.ok(p.id.startsWith("t_iv_"), `id esperado t_iv_*: ${p.id}`);
        assert.ok(p.name && p.role, "name e role preenchidos");
        assert.equal(p.gender, "", "gênero vazio (professor preenche)");
        assert.ok(Array.isArray(p.objectives) && p.objectives.length, "objetivos mapeados");
    }
});

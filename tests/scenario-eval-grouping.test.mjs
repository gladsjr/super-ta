// Agrupamento por persona do avaliador de cenário (puro — sem LLM, sem banco).
// node --test tests/scenario-eval-grouping.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByPersona } from "../agents/ScenarioEvaluatorAgent.js";

const scenario = {
    personas: [
        { id: "cp_l", name: "Larissa", role: "dona da fazenda" },
        { id: "cp_m", name: "Marcos", role: "investidor" },
    ],
    interactions: [
        { title: "Coleta", participants: [{ persona_id: "cp_l" }] },
        { title: "Defesa", participants: [{ persona_id: "cp_l" }] },
        { title: "Arguição", participants: [{ persona_id: "cp_m" }] },
    ],
};
const transcript = [
    { kind: "scenario", text: "frame do cenário" },
    { kind: "interaction", idx: 0, text: "Interação 1" },
    { kind: "student", text: "pergunta 1" },
    { kind: "persona", speaker: "cp_l", name: "Larissa", text: "resposta 1" },
    { kind: "hint", text: "dica qualquer" },
    { kind: "interaction", idx: 1, text: "Interação 2" },
    { kind: "student", text: "defendo X" },
    { kind: "persona", speaker: "cp_l", name: "Larissa", text: "confronto" },
    { kind: "interaction", idx: 2, text: "Interação 3" },
    { kind: "student", text: "argumento" },
    { kind: "persona", speaker: "cp_m", name: "Marcos", text: "pressão" },
];

test("agrupa por persona, consolidando as etapas da mesma persona", () => {
    const g = groupByPersona(scenario, transcript);
    assert.equal(g.length, 2, "duas personas distintas");

    const lari = g.find(x => x.name === "Larissa");
    assert.deepEqual(lari.titles, ["Coleta", "Defesa"], "Larissa consolida as 2 etapas dela");
    assert.ok(lari.lines.includes("ALUNO: pergunta 1") && lari.lines.includes("Larissa: resposta 1"));
    assert.ok(lari.lines.includes("ALUNO: defendo X") && lari.lines.includes("Larissa: confronto"));
    assert.ok(!lari.lines.some(l => l.includes("pressão")), "fala do Marcos não entra no thread da Larissa");

    const marcos = g.find(x => x.name === "Marcos");
    assert.deepEqual(marcos.titles, ["Arguição"]);
    assert.ok(marcos.lines.includes("ALUNO: argumento") && marcos.lines.includes("Marcos: pressão"));
});

test("hint e scenario são ignorados; persona desconhecida não quebra", () => {
    const g = groupByPersona({ personas: [], interactions: [] }, transcript);
    assert.equal(g.length, 0, "sem personas no cenário → nenhum grupo");
});

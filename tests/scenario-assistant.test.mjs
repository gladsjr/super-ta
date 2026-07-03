// Testes token-free do ScenarioAssistantAgent: saneamento das PROPOSTAS
// (ops add/update, formas/papéis válidos, private_info por nome) com um cliente
// OpenAI stub — não chama a API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScenarioAssistantAgent } from "../agents/ScenarioAssistantAgent.js";

function agentReturning(obj) {
    const stub = { responses: { create: async () => ({ output_text: JSON.stringify(obj) }) } };
    return new ScenarioAssistantAgent(stub, "fast-test");
}

test("propostas válidas são normalizadas (patch + persona add + interação consultoria com private_info)", async () => {
    const agent = agentReturning({
        reply: "Montei o esqueleto.",
        scenario_patch: { out_of_scope: "salários", premissas: "orçamento aprovado", lixo: "ignore" },
        personas: [{ op: "add", name: "Larissa", role: "sócia", objectives: ["entender o caso"], knowledge_scope: ["energia"], knowledge_level: "médio" }],
        interactions: [{ op: "add", title: "Levantamento", form: "consultoria", instruction: "diagnostique", time_limit_min: 10,
            participants: [{ persona_name: "Larissa", role: "entrevista" }],
            private_info: [{ text: "usina entrega 80kW", personas: ["Larissa"] }] }],
    });
    const out = await agent.chat({ scenario: {}, templates: [], history: [], message: "crie" });
    assert.equal(out.reply, "Montei o esqueleto.");
    assert.deepEqual(out.scenario_patch, { out_of_scope: "salários", premissas: "orçamento aprovado" });
    assert.equal(out.personas.length, 1);
    assert.equal(out.personas[0].op, "add");
    assert.equal(out.personas[0].knowledge_level, "médio");
    assert.deepEqual(out.personas[0].objectives, ["entender o caso"]);
    const it = out.interactions[0];
    assert.equal(it.op, "add");
    assert.equal(it.form, "consultoria");
    assert.equal(it.kind, "student");
    assert.equal(it.includes_student_work, false);   // default da consultoria
    assert.equal(it.time_limit_min, 10);
    // Regra de domínio: em CONSULTORIA o aluno conduz e a persona é a FONTE, então
    // um role "entrevista" proposto é normalizado para "fonte" (ver ScenarioAssistantAgent,
    // interactionForms.js e o studio.js que força fonte na UI). O teste antes esperava
    // o valor cru "entrevista"; o certo é o normalizado. [issue #68]
    assert.equal(it.participants[0].role, "fonte");
    assert.equal(it.private_info[0].text, "usina entrega 80kW");
    assert.deepEqual(it.private_info[0].personas, ["Larissa"]);
});

test("forma inválida é descartada; papel inválido vira questionamento; op default = add", async () => {
    const agent = agentReturning({
        reply: "ok",
        interactions: [{ title: "X", form: "inexistente", participants: [{ persona_name: "A", role: "xpto" }] }],
    });
    const out = await agent.chat({ scenario: {}, templates: [], history: [], message: "m" });
    const it = out.interactions[0];
    assert.equal(it.op, "add");
    assert.equal(it.form, undefined);                 // forma inválida não passa
    assert.equal(it.participants[0].role, "questionamento");
});

test("op update de interação carrega ref (número) e só os campos enviados", async () => {
    const agent = agentReturning({
        reply: "aumentei o tempo",
        interactions: [{ op: "update", ref: 1, time_limit_min: 20 }],
    });
    const out = await agent.chat({ scenario: {}, templates: [], history: [], message: "m" });
    const it = out.interactions[0];
    assert.equal(it.op, "update");
    assert.equal(it.ref, 1);
    assert.equal(it.time_limit_min, 20);
    assert.equal(it.title, undefined);                // não mexe no que não foi enviado
});

test("op de interação carrega position (reordenar/inserir em posição)", async () => {
    const agent = agentReturning({
        reply: "movi a etapa do CFO para o início",
        interactions: [{ op: "update", ref: "Entrevista inicial com o CFO", position: 1 }],
    });
    const out = await agent.chat({ scenario: {}, templates: [], history: [], message: "m" });
    assert.equal(out.interactions[0].op, "update");
    assert.equal(out.interactions[0].ref, "Entrevista inicial com o CFO");
    assert.equal(out.interactions[0].position, 1);
});

test("resposta sem reply válido cai no fallback seguro", async () => {
    const agent = agentReturning({ nope: true });
    const out = await agent.chat({ scenario: {}, templates: [], history: [], message: "m" });
    assert.match(out.reply, /não consegui/i);
    assert.deepEqual(out.personas, []);
    assert.deepEqual(out.interactions, []);
    assert.equal(out.scenario_patch, null);
});

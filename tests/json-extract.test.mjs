// Testes do lib/jsonExtract.js — extração tolerante do primeiro objeto JSON.
// Rodar: npm run test:json-extract  (ou: node --test tests/json-extract.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFirstJsonObject } from "../lib/jsonExtract.js";

const ACTION = '{"rationale":"ok","action":{"kind":"ask","message":"E aí?"},"memory":{"open_threads":[]}}';

test("JSON limpo passa intacto", () => {
    const r = extractFirstJsonObject(ACTION);
    assert.equal(r.json, ACTION);
    assert.equal(r.leading, "");
    assert.equal(r.trailing, "");
    assert.deepEqual(JSON.parse(r.json).action.kind, "ask");
});

test("texto residual após o JSON é separado (caso terra)", () => {
    const r = extractFirstJsonObject(ACTION + "\n\nObservação: mantive o tom da persona.");
    assert.equal(r.json, ACTION);
    assert.equal(r.trailing, "Observação: mantive o tom da persona.");
});

test("sufixo contendo chaves não contamina a fatia (o caso que quebrava o regex ganancioso)", () => {
    const r = extractFirstJsonObject(ACTION + ' {"eco":"duplicado"}');
    assert.equal(r.json, ACTION);
    assert.equal(r.trailing, '{"eco":"duplicado"}');
    assert.doesNotThrow(() => JSON.parse(r.json));
});

test("cerca de markdown antes e depois", () => {
    const r = extractFirstJsonObject("```json\n" + ACTION + "\n```");
    assert.equal(r.json, ACTION);
    assert.equal(r.leading, "```json");
    assert.equal(r.trailing, "```");
});

test("chaves dentro de strings não fecham o objeto", () => {
    const s = '{"message":"use { e } à vontade, até \\"} isso\\""}';
    const r = extractFirstJsonObject(s + " resto");
    assert.equal(r.json, s);
    assert.equal(JSON.parse(r.json).message, 'use { e } à vontade, até "} isso"');
});

test("escape de barra antes de aspas não descarrilha o scanner", () => {
    const s = '{"path":"C:\\\\pasta\\\\"}';
    const r = extractFirstJsonObject(s + "fim");
    assert.equal(r.json, s);
    assert.equal(r.trailing, "fim");
});

test("objetos aninhados fecham no par correto", () => {
    const s = '{"a":{"b":{"c":1}},"d":[{"e":2}]}';
    const r = extractFirstJsonObject("x" + s + "y");
    assert.equal(r.json, s);
    assert.equal(r.leading, "x");
    assert.equal(r.trailing, "y");
});

test("objeto truncado (não fecha) retorna null — vira o erro/retry existente", () => {
    assert.equal(extractFirstJsonObject('{"a":1'), null);
});

test("sem chave nenhuma retorna null", () => {
    assert.equal(extractFirstJsonObject("nenhum json aqui"), null);
    assert.equal(extractFirstJsonObject(""), null);
    assert.equal(extractFirstJsonObject(null), null);
});

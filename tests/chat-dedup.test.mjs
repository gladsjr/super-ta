// Testes do lib/chatDedup.js — idempotência do /chat da entrevista.
// Rodar: npm run test:chat-dedup  (ou: node --test tests/chat-dedup.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideChatDedup, markChatDone, abortChatDedup, IN_FLIGHT_STALE_MS } from "../lib/chatDedup.js";

const T0 = 1_000_000;

test("sem id (cliente antigo) sempre processa e não toca no estado", () => {
    const prev = { id: "x", status: "done", at: T0, result: { ok: 1 } };
    const dd = decideChatDedup(prev, null, T0 + 10);
    assert.equal(dd.decision, "process");
    assert.equal(dd.next, prev);
});

test("id novo processa e registra in_flight", () => {
    const dd = decideChatDedup(null, "a1", T0);
    assert.equal(dd.decision, "process");
    assert.deepEqual(dd.next, { id: "a1", status: "in_flight", at: T0, result: null });
});

test("id diferente do anterior processa e substitui o estado", () => {
    const prev = { id: "a1", status: "done", at: T0, result: { ok: 1 } };
    const dd = decideChatDedup(prev, "a2", T0 + 10);
    assert.equal(dd.decision, "process");
    assert.equal(dd.next.id, "a2");
    assert.equal(dd.next.status, "in_flight");
});

test("retry do mesmo id com turno concluído → replay do resultado (o bug do turno duplicado)", () => {
    const done = markChatDone({ id: "a1", status: "in_flight", at: T0, result: null }, "a1", { assistant: "resposta" }, T0 + 5000);
    const dd = decideChatDedup(done, "a1", T0 + 9000);
    assert.equal(dd.decision, "replay");
    assert.deepEqual(dd.next.result, { assistant: "resposta" });
});

test("retry do mesmo id ainda em processamento → reject_in_flight", () => {
    const dd = decideChatDedup({ id: "a1", status: "in_flight", at: T0, result: null }, "a1", T0 + 1000);
    assert.equal(dd.decision, "reject_in_flight");
});

test("in_flight morto (mais velho que o stale) → reprocessa", () => {
    const dd = decideChatDedup({ id: "a1", status: "in_flight", at: T0, result: null }, "a1", T0 + IN_FLIGHT_STALE_MS + 1);
    assert.equal(dd.decision, "process");
    assert.equal(dd.next.status, "in_flight");
    assert.equal(dd.next.at, T0 + IN_FLIGHT_STALE_MS + 1);
});

test("markChatDone só marca se o id confere", () => {
    const prev = { id: "a1", status: "in_flight", at: T0, result: null };
    assert.equal(markChatDone(prev, "OUTRO", { x: 1 }, T0), prev);
    assert.equal(markChatDone(prev, null, { x: 1 }, T0), prev);
    const done = markChatDone(prev, "a1", { x: 1 }, T0 + 1);
    assert.equal(done.status, "done");
});

test("abortChatDedup libera reenvio imediato só do in_flight do mesmo id", () => {
    assert.equal(abortChatDedup({ id: "a1", status: "in_flight", at: T0, result: null }, "a1"), null);
    const done = { id: "a1", status: "done", at: T0, result: { ok: 1 } };
    assert.equal(abortChatDedup(done, "a1"), done);   // done não se apaga (replay continua possível)
    const other = { id: "a2", status: "in_flight", at: T0, result: null };
    assert.equal(abortChatDedup(other, "a1"), other);
});

test("ciclo completo: process → done → replay → nova mensagem processa", () => {
    let state = null;
    let dd = decideChatDedup(state, "m1", T0);
    assert.equal(dd.decision, "process");
    state = dd.next;
    state = markChatDone(state, "m1", { assistant: "olá" }, T0 + 3000);
    dd = decideChatDedup(state, "m1", T0 + 6000);          // retry de transporte
    assert.equal(dd.decision, "replay");
    dd = decideChatDedup(state, "m2", T0 + 60_000);        // próxima mensagem real
    assert.equal(dd.decision, "process");
});

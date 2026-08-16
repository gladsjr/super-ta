// Elegibilidade de LOTE (#258): o lote avalia quem de fato fez a arguição.
// Envio de teste, arguição em andamento e desistência só individualmente.
//
//   node --test tests/batch-eligibility.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBatchEligible, batchIneligibleReason, summarizeIneligible, batchEligibleSql } from "../lib/batchEligibility.js";

const sub = (over = {}) => ({ is_test: false, status: "completed", ...over });

test("aluno que concluiu entra", () => {
    assert.equal(isBatchEligible(sub()), true);
    assert.equal(batchIneligibleReason(sub()), null);
});

test("envio de teste fica de fora, mesmo concluído", () => {
    const s = sub({ is_test: true });
    assert.equal(isBatchEligible(s), false);
    assert.equal(batchIneligibleReason(s), "envio de teste");
});

test("desistência fica de fora", () => {
    const s = sub({ status: "gave_up" });
    assert.equal(isBatchEligible(s), false);
    assert.equal(batchIneligibleReason(s), "desistência");
});

test("arguição em andamento fica de fora", () => {
    assert.equal(isBatchEligible(sub({ status: "in_progress" })), false);
    assert.equal(batchIneligibleReason(sub({ status: "in_progress" })), "arguição em andamento");
});

test("aguardando vídeo fica de fora (a sessão ainda não concluiu)", () => {
    assert.equal(isBatchEligible(sub({ status: "awaiting_video" })), false);
    assert.equal(batchIneligibleReason(sub({ status: "awaiting_video" })), "aguardando o vídeo");
});

test("sem envio fica de fora", () => {
    assert.equal(isBatchEligible(sub({ status: "pending" })), false);
    assert.equal(batchIneligibleReason(sub({ status: "pending" })), "sem envio");
});

test("teste tem precedência sobre o status ao explicar o motivo", () => {
    assert.equal(batchIneligibleReason(sub({ is_test: true, status: "gave_up" })), "envio de teste");
});

test("resumo agrupa os excluídos por motivo", () => {
    const resumo = summarizeIneligible([
        sub(), sub(),                                  // 2 elegíveis (não entram no resumo)
        sub({ is_test: true }), sub({ is_test: true }),
        sub({ status: "gave_up" }),
        sub({ status: "in_progress" }),
    ]);
    assert.deepEqual(resumo, { "envio de teste": 2, "desistência": 1, "arguição em andamento": 1 });
});

test("o SQL diz a MESMA coisa que o predicado em JS", () => {
    const sql = batchEligibleSql();
    assert.match(sql, /is_test = false/);
    assert.match(sql, /completion_reason IS NOT NULL/);
    assert.match(sql, /completion_reason <> 'give_up'/);
    // com alias, prefixa todas as colunas
    const comAlias = batchEligibleSql("s");
    assert.match(comAlias, /s\.is_test/);
    assert.match(comAlias, /s\.completion_reason IS NOT NULL/);
    assert.ok(!/[^.]\bis_test/.test(comAlias.replace(/s\.is_test/g, "")), "toda coluna precisa do prefixo");
});

test("entrada nula não quebra", () => {
    assert.equal(isBatchEligible(null), false);
    assert.equal(batchIneligibleReason(null), "desconhecida");
    assert.deepEqual(summarizeIneligible(null), {});
});

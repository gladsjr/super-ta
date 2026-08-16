// Triagem do professor sobre os indícios de fiscalização (#246).
// A classificação é HUMANA — é isso que a torna compatível com a ADR 0004, que
// proíbe acusação e penalidade AUTOMÁTICAS. Os testes abaixo protegem as guardas
// que a ADR impõe.
//
//   node --test tests/proctor-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PROCTOR_REVIEW_DEFS, PROCTOR_REVIEW_KEYS, PROCTOR_REVIEW_DEFAULT,
    isValidProctorReview, entraNaDevolutiva, renderProctorReviewForPrompt,
} from "../lib/proctorReview.js";

test("o default é 'não revisado', e ele é DISTINTO de 'em aberto'", () => {
    assert.equal(PROCTOR_REVIEW_DEFAULT, "nao_revisado");
    assert.ok(PROCTOR_REVIEW_KEYS.includes("em_aberto"));
    assert.notEqual(PROCTOR_REVIEW_DEFAULT, "em_aberto");
});

test("só chaves conhecidas são aceitas", () => {
    for (const k of PROCTOR_REVIEW_KEYS) assert.equal(isValidProctorReview(k), true);
    assert.equal(isValidProctorReview("confirmado"), false);
    assert.equal(isValidProctorReview(""), false);
    assert.equal(isValidProctorReview(null), false);
});

test("ADR 0004: 'não revisado' e 'sem problema' NÃO entram na devolutiva", () => {
    assert.equal(entraNaDevolutiva("nao_revisado"), false);
    assert.equal(entraNaDevolutiva("sem_problema"), false);
    assert.equal(renderProctorReviewForPrompt({ level: "sem_problema", note: "vi o vídeo, é a mão" }, { paraDevolutiva: true }), null);
});

test("'em aberto' também não vai à devolutiva — inconclusivo não é achado", () => {
    assert.equal(entraNaDevolutiva("em_aberto"), false);
    assert.equal(renderProctorReviewForPrompt({ level: "em_aberto" }, { paraDevolutiva: true }), null);
});

test("confirmado vai à devolutiva, com instrução formativa e sem acusar", () => {
    const txt = renderProctorReviewForPrompt(
        { level: "confirmado_moderado", note: "consultou o computador aos 32 min" },
        { paraDevolutiva: true },
    );
    assert.ok(txt);
    assert.match(txt, /FORMATIVA/);
    assert.match(txt, /NÃO acuse/);
    assert.match(txt, /NÃO impute causa/);
    assert.match(txt, /consultou o computador/, "a observação do professor chega ao gerador");
});

test("na avaliação interna, 'sem problema' instrui a NÃO tratar como achado", () => {
    const txt = renderProctorReviewForPrompt({ level: "sem_problema" });
    assert.ok(txt);
    assert.match(txt, /NÃO confirmou problema/);
});

test("na avaliação interna, confirmado entra como contexto confirmado", () => {
    const txt = renderProctorReviewForPrompt({ level: "confirmado_grave" });
    assert.match(txt, /CONFIRMADO por revisão humana/);
});

test("'não revisado' sem observação não injeta nada em lugar nenhum", () => {
    assert.equal(renderProctorReviewForPrompt({ level: "nao_revisado" }), null);
    assert.equal(renderProctorReviewForPrompt(null), null);
    assert.equal(renderProctorReviewForPrompt({}), null);
});

test("observação sozinha já vale contexto, mesmo sem classificar", () => {
    const txt = renderProctorReviewForPrompt({ level: "nao_revisado", note: "vídeo cortado no meio" });
    assert.match(txt, /vídeo cortado no meio/);
});

test("todo nível tem nome de exibição e ordem", () => {
    for (const d of PROCTOR_REVIEW_DEFS) {
        assert.ok(d.name && d.name.trim(), `${d.key} sem nome`);
        assert.equal(typeof d.ordem, "number");
        assert.equal(typeof d.confirmado, "boolean");
    }
});

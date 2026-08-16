// Retomada de sessão de voz exige liberação do professor (#260, ADR 0020).
// A decisão "isto é uma retomada?" é fonte única (lib/resumeGate.js) para os
// dois fluxos de voz — estes testes protegem o critério.
//
//   node --test tests/resume-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { wouldResume, studentTurnCount, RESUME_BLOCKED } from "../lib/resumeGate.js";

const fala = (role, text = "…") => ({ role, text });

test("sessão com fala do aluno é retomada (bloqueia sem liberação)", () => {
    assert.equal(wouldResume({ isTest: false, priorTranscript: [fala("examiner"), fala("student")] }), true);
});

test("queda durante a apresentação (só examinador) NÃO é retomada — recomeça normal", () => {
    assert.equal(wouldResume({ isTest: false, priorTranscript: [fala("examiner"), fala("examiner")] }), false);
});

test("primeira entrada (sem transcrição) não é retomada", () => {
    assert.equal(wouldResume({ isTest: false, priorTranscript: [] }), false);
    assert.equal(wouldResume({ isTest: false, priorTranscript: null }), false);
    assert.equal(wouldResume({ isTest: false, priorTranscript: undefined }), false);
});

test("token de TESTE sempre recomeça — nunca bloqueia", () => {
    assert.equal(wouldResume({ isTest: true, priorTranscript: [fala("student")] }), false);
});

test("transcrição malformada não derruba a decisão", () => {
    assert.equal(wouldResume({ isTest: false, priorTranscript: [null, {}, { role: "student" }] }), true);
    assert.equal(wouldResume({ isTest: false, priorTranscript: [null, {}] }), false);
});

test("contagem de falas do aluno (o 'onde parou' do professor)", () => {
    assert.equal(studentTurnCount([fala("examiner"), fala("student"), fala("student"), null]), 2);
    assert.equal(studentTurnCount(null), 0);
});

test("o código de erro é estável — as páginas do aluno dependem dele", () => {
    assert.equal(RESUME_BLOCKED, "resume_blocked");
});

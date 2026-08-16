// per_question na devolutiva deixou de ser escolha do modelo (#251).
// Quando o relatório interno tem comentários por turno, a devolutiva do aluno
// DEVE cobrir todos — senão colegas da mesma turma recebem estruturas diferentes
// por variação não determinística, sem critério pedagógico por trás.
//
//   node --test tests/student-feedback-per-question.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { StudentFeedbackAgent, validateStudentFeedbackShape } from "../agents/StudentFeedbackAgent.js";

const agente = Object.create(StudentFeedbackAgent.prototype); // só o validador; sem rede
const devolutiva = (perQuestion) => ({
    summary: "Você sustentou bem a ideia central e deixou lacunas na parte de dados.",
    per_question: perQuestion,
    strengths: [],
    improvement_areas: [],
    study_suggestions: [],
});
const entrada = (i) => ({ turn_index: i, feedback: `comentário do turno ${i}` });
const interno = (idxs) => ({ per_question: idxs.map(i => ({ turn_index: i, comment: "x" })) });

test("cobertura completa passa", () => {
    agente._validateReport(devolutiva([entrada(0), entrada(1), entrada(2)]), interno([0, 1, 2]));
});

test("per_question VAZIO é rejeitado quando o relatório interno tem entradas", () => {
    // Este é exatamente o caso relatado: a aluna saiu com 0 enquanto a turma saiu
    // com 5 ou 6, e a avaliação interna dela tinha 5.
    assert.throws(
        () => agente._validateReport(devolutiva([]), interno([0, 1, 2, 3, 4])),
        /per_question incompleto/,
    );
});

test("cobertura PARCIAL é rejeitada (antes era aceita)", () => {
    assert.throws(
        () => agente._validateReport(devolutiva([entrada(0), entrada(2)]), interno([0, 1, 2])),
        /faltam os turnos 1/,
    );
});

test("o erro carrega orientação para a retentativa, dizendo o que faltou", () => {
    try {
        agente._validateReport(devolutiva([entrada(0)]), interno([0, 1, 2]));
        assert.fail("deveria ter lançado");
    } catch (err) {
        assert.ok(err.guidance, "erro deve trazer .guidance para injetar no retry");
        assert.match(err.guidance, /1, 2/, "a orientação diz QUAIS turnos faltaram");
        assert.match(err.guidance, /NÃO é opcional/);
    }
});

test("turn_index inexistente no relatório interno continua sendo erro", () => {
    assert.throws(
        () => agente._validateReport(devolutiva([entrada(0), entrada(9)]), interno([0])),
        /turn_index 9 não existe/,
    );
});

test("relatório interno SEM per_question aceita devolutiva sem a seção", () => {
    agente._validateReport(devolutiva([]), interno([]));
});

test("validateStudentFeedbackShape segue exigindo o formato básico", () => {
    assert.throws(() => validateStudentFeedbackShape({ summary: "" }), /summary/);
    assert.throws(() => validateStudentFeedbackShape({ summary: "ok" }), /per_question/);
    assert.throws(
        () => validateStudentFeedbackShape({ summary: "ok", per_question: [{ turn_index: 0, feedback: "" }], strengths: [], improvement_areas: [], study_suggestions: [] }),
        /feedback vazio/,
    );
});

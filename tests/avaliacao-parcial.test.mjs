// Sessão interrompida vira nota defensável, não nota inventada (#362).
//
// Uma aluna respondeu 3 das 4 perguntas de uma reposição e desistiu na última,
// pedindo no comentário final que o avanço fosse avaliado assim mesmo. A nota
// teve de ser calculada à mão e a devolutiva escrita no LMS da instituição —
// justamente a devolutiva por pergunta, que é o que a plataforma faz de melhor.
//
// A regra que estes testes fixam: a pergunta que NUNCA foi feita não vale zero
// (seria punir o aluno por algo que não aconteceu) nem some da conta (seria
// esconder do professor que a nota veio de menos questões). Ela fica na lista,
// sem nota, marcada.
//
//   node --test tests/avaliacao-parcial.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradesFromReport } from "../routes/oralExam.js";

// 4 questões sorteadas para o aluno, pesos iguais.
const QUESTOES = [
    { id: 1, question: "O que é liquidez?", weight: 1 },
    { id: 2, question: "Explique o spread.", weight: 1 },
    { id: 3, question: "Qual o risco de contraparte?", weight: 1 },
    { id: 4, question: "Como se mede a volatilidade?", weight: 1 },
];

test("prova completa: nada é neutralizado", () => {
    const report = { per_question: QUESTOES.map(q => ({ id: q.id, question: q.question, score: 7.5, comment: "ok" })) };
    const g = gradesFromReport(report, QUESTOES);
    assert.equal(g.criteria.length, 4);
    assert.equal(g.partial, null, "prova inteira não pode ser marcada como parcial");
    assert.equal(g.final, 7.5);
});

test("interrompida: a pergunta não feita entra sem nota e NÃO puxa a média", () => {
    // O caso real: 3 respondidas, a 4ª nunca chegou a ser feita.
    const report = { per_question: [
        { id: 1, question: QUESTOES[0].question, score: 10, comment: "" },
        { id: 2, question: QUESTOES[1].question, score: 10, comment: "" },
        { id: 3, question: QUESTOES[2].question, score: 10, comment: "" },
    ] };
    const g = gradesFromReport(report, QUESTOES);

    assert.equal(g.final, 10,
        "a 4ª não pode entrar como zero — seria punir o aluno por algo que não aconteceu");
    assert.equal(g.criteria.length, 4,
        "e não pode sumir da lista — o professor precisa ver o que foi neutralizado");

    const naoFeita = g.criteria.find(c => c.id === 4);
    assert.equal(naoFeita.score, null);
    assert.equal(naoFeita.not_asked, true);
    assert.match(naoFeita.justification, /não entra na média/i);

    assert.deepEqual(g.partial, { not_asked: 1, scored: 3 },
        "a listagem lê daqui para marcar a prova como avaliada parcialmente");
});

test("respondida mal continua valendo zero — só a NÃO FEITA é neutralizada", () => {
    // A distinção que a issue pede explicitamente: o aluno ouviu a pergunta e
    // não soube responder. Isso é desempenho, e conta.
    const report = { per_question: [
        { id: 1, question: QUESTOES[0].question, score: 10, comment: "" },
        { id: 2, question: QUESTOES[1].question, score: 0, comment: "não soube responder" },
    ] };
    const g = gradesFromReport(report, QUESTOES);
    assert.equal(g.final, 5, "a nota zero da respondida entra na média (10 e 0 → 5)");
    assert.equal(g.criteria.find(c => c.id === 2).score, 0);
    assert.equal(g.criteria.find(c => c.id === 2).not_asked, undefined);
    assert.equal(g.partial.not_asked, 2, "as duas que nunca foram feitas ficam marcadas");
});

test("pesos são respeitados na renormalização", () => {
    const pesos = [
        { id: 1, question: "a", weight: 3 },
        { id: 2, question: "b", weight: 1 },
        { id: 3, question: "c", weight: 6 },   // nunca feita: sai da conta inteira
    ];
    const report = { per_question: [
        { id: 1, question: "a", score: 10, comment: "" },
        { id: 2, question: "b", score: 2.5, comment: "" },
    ] };
    const g = gradesFromReport(report, pesos);
    // (10×3 + 2,5×1) / 4 = 8,125 → 8,1. O peso 6 da não feita não entra no
    // denominador; se entrasse, a nota despencaria para 3,3.
    assert.equal(g.final, 8.1);
});

test("sem nenhuma questão avaliada, não há nota", () => {
    assert.equal(gradesFromReport({ per_question: [] }, QUESTOES), null,
        "sessão sem nada respondido não produz nota — não há o que renormalizar");
});

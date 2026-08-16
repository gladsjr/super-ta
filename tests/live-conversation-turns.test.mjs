// Segmentação do transcript da entrevista SIMPLIFICADA em turnos (#252).
// Regra: turno = pergunta do plano. Fala conversacional do entrevistador
// (confirmação, ponte, pedido de complemento) é INTERVENÇÃO do turno corrente,
// não turno novo — mesma semântica da entrevista por mensagem.
//
//   node --test tests/live-conversation-turns.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcriptToTurns } from "../lib/liveConversation.js";

const plano = [
    { id: 1, question: "Como você fundamenta a conclusão sobre o impacto ambiental na seção três?" },
    { id: 2, question: "Qual evidência diferencia o uso de stablecoin para pagamento e para especulação?" },
    { id: 3, question: "Por que você escolheu lastro fiduciário em vez de lastro algorítmico?" },
];
const DESPEDIDA = "Obrigado, encerramos por aqui.";

const fala = (role, text) => ({ role, text });

test("pergunta do plano abre turno; conversa vira intervenção", () => {
    const turns = transcriptToTurns([
        fala("examiner", "Como você fundamenta a conclusão sobre o impacto ambiental na seção três?"),
        fala("student", "A conclusão vem da tabela 2, com os dados de consumo."),
        fala("examiner", "Entendi."),
        fala("student", "Isso."),
        fala("examiner", "Pode dar um exemplo prático?"),
        fala("student", "Por exemplo, a redução de 15% no consumo de água."),
        fala("examiner", "Qual evidência diferencia o uso de stablecoin para pagamento e para especulação?"),
        fala("student", "O giro da carteira e o tamanho médio da transação."),
    ], plano, DESPEDIDA);

    assert.equal(turns.length, 2, "duas perguntas do plano → dois turnos");
    assert.equal(turns[0].question_metadata.id, 1);
    assert.equal(turns[1].question_metadata.id, 2);
    assert.equal(turns[0].interventions.length, 2, "'Entendi' e 'Pode dar um exemplo' são intervenções");
    assert.equal(turns[0].interventions[0].assistant_response, "Entendi.");
    assert.equal(turns[0].interventions[0].student_message, "Isso.");
    assert.equal(turns[0].interventions[1].student_message, "Por exemplo, a redução de 15% no consumo de água.");
});

test("o caso real: conversa que virava 14 turnos agora vira 3", () => {
    const t = [];
    for (const q of plano) {
        t.push(fala("examiner", q.question));
        t.push(fala("student", "Resposta à pergunta do plano."));
        t.push(fala("examiner", "Certo, entendi."));            // ponte
        t.push(fala("student", "Complemento."));
        t.push(fala("examiner", "Ok, vamos adiante então."));   // ponte
    }
    t.push(fala("examiner", DESPEDIDA));
    const turns = transcriptToTurns(t, plano, DESPEDIDA);
    assert.equal(turns.length, 3, "um turno por pergunta do plano");
    assert.deepEqual(turns.map(x => x.question_metadata.id), [1, 2, 3]);
});

test("nenhuma fala é perdida", () => {
    const transcript = [
        fala("examiner", "Por que você escolheu lastro fiduciário em vez de lastro algorítmico?"),
        fala("student", "Porque é mais simples de auditar."),
        fala("examiner", "E o custo de custódia?"),
        fala("student", "Some no volume."),
    ];
    const turns = transcriptToTurns(transcript, plano, DESPEDIDA);
    const registrado = turns.flatMap(t => [
        t.question,
        t.answer,
        ...t.interventions.flatMap(i => [i.assistant_response, i.student_message]),
    ]).filter(Boolean).join("\n");
    for (const f of transcript) assert.ok(registrado.includes(f.text), `perdeu: ${f.text}`);
});

test("despedida do sistema não vira turno", () => {
    const turns = transcriptToTurns([
        fala("examiner", plano[0].question),
        fala("student", "Resposta."),
        fala("examiner", DESPEDIDA),
    ], plano, DESPEDIDA);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].interventions.length, 0);
});

test("fallback: se nada casa com o plano, segmenta por fala em vez de colapsar", () => {
    const turns = transcriptToTurns([
        fala("examiner", "Vamos falar de outra coisa completamente diferente."),
        fala("student", "Certo."),
        fala("examiner", "E aquele outro assunto que não está no plano?"),
        fala("student", "Também."),
    ], plano, DESPEDIDA);
    assert.equal(turns.length, 2, "sem casamento, cai para a segmentação por fala");
    assert.equal(turns[0].question_metadata.id, null);
});

test("sem plano nenhum, mantém a segmentação por fala", () => {
    const turns = transcriptToTurns([
        fala("examiner", "Primeira."),
        fala("student", "A."),
        fala("examiner", "Segunda."),
        fala("student", "B."),
    ], [], DESPEDIDA);
    assert.equal(turns.length, 2);
});

test("fala do aluno antes de qualquer pergunta não é perdida", () => {
    const turns = transcriptToTurns([
        fala("student", "Alô? Está me ouvindo?"),
        fala("examiner", plano[0].question),
        fala("student", "Resposta."),
    ], plano, DESPEDIDA);
    assert.equal(turns[0].answer, "Alô? Está me ouvindo?");
    assert.equal(turns[1].question_metadata.id, 1);
});

test("entrevistador reformula antes de qualquer resposta: mesma pergunta, não intervenção", () => {
    const turns = transcriptToTurns([
        fala("examiner", plano[0].question),
        fala("examiner", "Ou seja: de onde vêm esses números?"),
        fala("student", "Da tabela 2."),
    ], plano, DESPEDIDA);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].interventions.length, 0);
    assert.ok(turns[0].question.includes("de onde vêm esses números"));
});

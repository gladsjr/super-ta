// Teste de robustez do attachAudioChunks (lib/sessionLifecycle.js).
//
// Regressão do bug: em modo áudio, uma falha de TTS num pedaço que não fosse o
// 1º fazia `break` — descartando o restante (que podia ser a própria pergunta)
// E nunca emitindo is_last, travando a vez do aluno. As invariantes que este
// teste protege:
//   (1) nenhum conteúdo é descartado: a união dos textos efetivamente
//       sintetizados cobre TODA a fala original;
//   (2) o turno sempre termina: exatamente um pedaço emitido carrega is_last;
//   (3) só degrada a texto (audio_error: tts_failed) quando NADA pôde ser
//       sintetizado.
//
// Estratégia: monkeypatch de openai.audio.speech.create (único ponto de rede).
// sess.workId = null => sessionMeterCtx nulo => recordCost retorna cedo, sem DB.

import assert from "node:assert/strict";
import { openai } from "../lib/openaiClient.js";
import { attachAudioChunks } from "../lib/sessionLifecycle.js";
import { AudioCache } from "../lib/audio.js";

// Três sentenças longas (~150 chars cada) -> splitForSpeech rende 3 pedaços:
// [s0], [s1], [s2] (cada uma já passa do limiar de 140 chars sozinha).
const S0 = "Está bem claro até aqui, e eu concordo que a parte conceitual estava bem amarrada no texto que você entregou para a banca avaliar com calma.";
const S1 = "Agora eu vou para outro ponto que me preocupa bastante como decisão de alocação de capital ao longo de todo o horizonte do projeto apresentado.";
const S2 = "Se as máquinas acabaram de ser compradas, o que exatamente justificaria trocar tão cedo em vez de já começar com a melhor configuração possível?";
const CONTENT = `${S0} ${S1} ${S2}`;

function makeSess() {
    return {
        submissionToken: "tok_test",
        interactionMode: "audio",
        voice: "echo",
        workId: null,           // -> sessionMeterCtx nulo -> sem DB
        submissionId: null,
        audioTurnIdCounter: 0,
        audioCache: new AudioCache(10),
        lastInterviewerAudio: null,
    };
}

// Instala um mock de speech.create. `failFor(input, callIndex)` -> boolean:
// se true, a chamada lança (simula erro transitório/definitivo de TTS).
// Devolve { calls } com o texto de cada chamada (na ordem) para inspeção.
function installTtsMock(failFor) {
    const calls = [];
    const fakeAudio = { speech: { create: async ({ input }) => {
        const idx = calls.length;
        calls.push(input);
        if (failFor(input, idx)) throw new Error(`mock TTS fail #${idx}`);
        return { arrayBuffer: async () => new Uint8Array([0x49, 0x44, 0x33, 0x03]).buffer };
    } } };
    const original = openai.audio;
    openai.audio = fakeAudio;
    return { calls, restore: () => { openai.audio = original; } };
}

// Concatena os textos sintetizados e confere que cada sentença original aparece
// inteira em algum pedaço (nada foi descartado).
function assertNoContentLost(syntInputs, label) {
    const joined = syntInputs.join(" || ");
    for (const s of [S0, S1, S2]) {
        assert.ok(joined.includes(s), `${label}: sentença perdida -> "${s.slice(0, 40)}..."`);
    }
}

function assertExactlyOneIsLast(chunks, label) {
    const lasts = chunks.filter(c => c.is_last);
    assert.equal(lasts.length, 1, `${label}: esperava exatamente 1 is_last, veio ${lasts.length}`);
    assert.equal(chunks[chunks.length - 1].is_last, true, `${label}: o is_last não foi o último pedaço`);
}

let passed = 0;
async function run(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  XX  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

console.log("attachAudioChunks — robustez:");

// 1) Caminho feliz: 3 pedaços, todos sintetizam.
await run("happy path: 3 pedaços, último com is_last, nada perdido", async () => {
    const mock = installTtsMock(() => false);
    try {
        const chunks = [];
        const res = await attachAudioChunks(makeSess(), CONTENT, (c) => chunks.push(c));
        assert.equal(res.chunk_count, 3, "esperava 3 pedaços");
        assert.ok(!res.audio_error, "não devia haver audio_error");
        assertExactlyOneIsLast(chunks, "happy");
        assertNoContentLost(mock.calls, "happy");
    } finally { mock.restore(); }
});

// 2) Falha transitória no último pedaço, retry resolve.
await run("retry: 1ª tentativa do último pedaço falha, 2ª resolve", async () => {
    const failedOnce = new Set();
    const mock = installTtsMock((input) => {
        if (input === S2 && !failedOnce.has(S2)) { failedOnce.add(S2); return true; }
        return false;
    });
    try {
        const chunks = [];
        const res = await attachAudioChunks(makeSess(), CONTENT, (c) => chunks.push(c));
        assert.equal(res.chunk_count, 3, "retry devia manter os 3 pedaços");
        assert.ok(!res.audio_error, "retry não devia degradar");
        assertExactlyOneIsLast(chunks, "retry");
        assertNoContentLost(mock.calls, "retry");
    } finally { mock.restore(); }
});

// 3) Pedaço do MEIO falha nas 2 tentativas -> fallback sintetiza o restante
//    (S1+S2) num blob. A pergunta (S2) NÃO se perde — era o bug.
await run("fallback: pedaço do meio falha 2x, restante vira blob (pergunta preservada)", async () => {
    const mock = installTtsMock((input) => input === S1); // S1 sempre falha
    try {
        const chunks = [];
        const res = await attachAudioChunks(makeSess(), CONTENT, (c) => chunks.push(c));
        assert.ok(!res.audio_error, "fallback bem-sucedido não devia ter audio_error");
        assertExactlyOneIsLast(chunks, "fallback");
        // Houve uma chamada de fallback cujo input contém S1 E S2 juntos.
        const blob = mock.calls.find(t => t.includes(S1) && t.includes(S2));
        assert.ok(blob, "fallback: esperava um blob com S1+S2 juntos");
        assertNoContentLost(mock.calls, "fallback");
    } finally { mock.restore(); }
});

// 4) Catástrofe total: 1º pedaço falha e o fallback também -> degrada a texto.
await run("catástrofe: nada sintetiza -> audio_error tts_failed, sem is_last falso", async () => {
    const mock = installTtsMock(() => true); // tudo falha
    try {
        const chunks = [];
        const res = await attachAudioChunks(makeSess(), CONTENT, (c) => chunks.push(c));
        assert.equal(res.audio_error, "tts_failed", "deveria degradar a texto");
        assert.equal(chunks.length, 0, "nada emitido");
    } finally { mock.restore(); }
});

// 5) Catástrofe parcial: 1º pedaço OK, resto (incl. fallback) falha -> emite o
//    1º, sinaliza fim com pedaço nulo is_last, retorna tts_partial. A vez do
//    aluno não pode travar.
await run("catástrofe parcial: emite o 1º + is_last nulo, retorna tts_partial", async () => {
    const mock = installTtsMock((input) => input !== S0); // só S0 passa
    try {
        const chunks = [];
        const res = await attachAudioChunks(makeSess(), CONTENT, (c) => chunks.push(c));
        assert.equal(res.audio_error, "tts_partial", "esperava tts_partial");
        assert.ok(res.chunk_count >= 1, "ao menos o 1º pedaço");
        assertExactlyOneIsLast(chunks, "parcial");
        const last = chunks[chunks.length - 1];
        assert.equal(last.audio_url, null, "o pedaço de fim catastrófico tem audio_url nulo");
    } finally { mock.restore(); }
});

console.log(`\n${passed}/5 testes ok`);
if (process.exitCode) { console.error("FALHOU"); } else { console.log("TODOS PASSARAM"); }

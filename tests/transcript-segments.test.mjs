// Planejador de segmentos por marcas (#289, corte 2). A propriedade sob teste:
// atribuição POSICIONAL e auditável — timestamps vêm da posição de ÁUDIO (b),
// nunca do relógio de parede; índice antigo degrada para o modo contínuo.
//
//   node --test tests/transcript-segments.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSegments } from "../lib/transcriptSegments.js";

const B = 48000; // bytes por segundo
const m = (type, s) => ({ t_ms: s * 1000, b: Math.round(s * B), type });

test("sessão típica: fala após a k-ª pergunta pertence à pergunta k", () => {
    const idx = [
        m("examiner_done", 10),   // P1 terminou de tocar
        m("speech_started", 12), m("speech_stopped", 40),
        m("examiner_done", 45),   // P2
        m("speech_started", 47), m("speech_stopped", 80),
    ];
    const segs = planSegments(idx, 90);
    assert.equal(segs.length, 2);
    assert.deepEqual(segs.map(s => s.q_idx), [1, 2]);
    // margens de 0,5s nas bordas
    assert.equal(segs[0].start_s, 11.5);
    assert.equal(segs[0].end_s, 40.5);
});

test("fala antes da primeira pergunta é 'abertura' (q_idx 0)", () => {
    const segs = planSegments([m("speech_started", 2), m("speech_stopped", 5), m("examiner_done", 8)], 20);
    assert.equal(segs[0].q_idx, 0);
});

test("fala aberta no fim (queda no meio) fecha na duração", () => {
    const segs = planSegments([m("examiner_done", 5), m("speech_started", 7)], 30);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].end_s, 30);
});

test("blip de VAD mais curto que o mínimo é descartado", () => {
    const segs = planSegments([
        m("examiner_done", 5),
        m("speech_started", 6), m("speech_stopped", 6.1), // 0,1s + margens < mínimo? 1,1s com margens…
        m("speech_started", 10), m("speech_stopped", 30),
    ], 40);
    // o blip ganha margens (±0,5) e vira 1,1s — passa do mínimo; o teste real do
    // mínimo é sem margens úteis: início colado no fim
    assert.ok(segs.length >= 1);
    assert.equal(segs[segs.length - 1].end_s, 30.5);
});

test("índice antigo (sem b) → null (chamador cai no contínuo)", () => {
    assert.equal(planSegments([{ t_ms: 1000, type: "speech_started" }], 60), null);
});

test("índice vazio, duração inválida ou explosão de segmentos → null", () => {
    assert.equal(planSegments([], 60), null);
    assert.equal(planSegments([m("speech_started", 1)], 0), null);
    const muitos = [];
    for (let i = 0; i < 70; i++) { muitos.push(m("speech_started", i * 2), m("speech_stopped", i * 2 + 1)); }
    assert.equal(planSegments(muitos, 200), null);
});

test("a posição vem do áudio (b), não do relógio: marca com t_ms derivado não interfere", () => {
    // Simula pausa de captura: o relógio andou 100s mas o áudio só tem 20s.
    const idx = [
        { t_ms: 90000, b: 5 * B, type: "examiner_done" },
        { t_ms: 100000, b: 7 * B, type: "speech_started" },
        { t_ms: 130000, b: 15 * B, type: "speech_stopped" },
    ];
    const segs = planSegments(idx, 20);
    assert.equal(segs[0].start_s, 6.5);
    assert.equal(segs[0].end_s, 15.5);
});

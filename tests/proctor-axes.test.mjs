// Limiares da fiscalização em fonte única (#245) e painel por eixo (#244).
// Dois princípios sob teste: o limiar DESTACA em vez de OCULTAR (todo eixo
// analisado aparece), e celular é medido em SEGUNDOS, não em percentual.
//
//   node --test tests/proctor-axes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
await import("../static/js/proctorAxes.js");
const { evaluate, hasAlert, coverageWarning } = globalThis.window.proctorAxes;

const rel = (flags, extra = {}) => ({ flags, ...extra });
const eixo = (r, key) => evaluate(r).find(e => e.key === key);

test("todo eixo analisado aparece, mesmo sem alerta (limiar destaca, não oculta)", () => {
    const eixos = evaluate(rel({
        phone: { count: 0, count_sec: 0, at: [] },
        absent: { count: 0, pct: 0, at: [] },
        multiple_people: { count: 0, pct: 0, at: [] },
        hands: { flag: false, absent_pct: 5 },
        framing: { flag: false, bad_pct: 0 },
    }));
    assert.equal(eixos.length, 5, "os cinco eixos aparecem");
    assert.ok(eixos.every(e => e.state === "ok"));
    assert.equal(hasAlert(eixos), false);
});

test("caso real de falso positivo confirmado: não alerta, mas continua visível", () => {
    // Envio d4c0cc283bac: 23 detecções ESPALHADAS ao longo de 11 min, revisão
    // humana do vídeo inteiro confirmou que não havia celular.
    const r = rel({ phone: { count: 23, count_sec: 23, pct: 3, raw_count: 400, at: [57, 59, 88, 153] } });
    const e = eixo(r, "phone");
    assert.equal(e.state, "ok", "23 s espalhados não disparam");
    assert.match(e.detail, /23 s no total/, "mas os números continuam na tela");
    assert.match(e.detail, /400 brutas/, "e a contagem bruta fica auditável");
});

test("celular SUSTENTADO dispara (sequência contígua)", () => {
    const e = eixo(rel({ phone: { count: 12, count_sec: 12, pct: 2, max_run_sec: 12, at: [100] } }), "phone");
    assert.equal(e.state, "alert");
    assert.match(e.detail, /maior sequência 12 s/);
});

test("celular ESPALHADO porém abundante dispara pelo total", () => {
    const e = eixo(rel({ phone: { count: 35, count_sec: 35, pct: 4, max_run_sec: 3, at: [] } }), "phone");
    assert.equal(e.state, "alert");
});

test("percentual não decide mais o celular", () => {
    // 40% da sessão, mas só 4 s de vídeo curto: não é o caso que o limiar quer pegar.
    const e = eixo(rel({ phone: { count: 4, count_sec: 4, pct: 40, max_run_sec: 4, at: [] } }), "phone");
    assert.equal(e.state, "ok");
});

test("relatório ANTIGO (sem count_sec nem max_run_sec) degrada sem quebrar", () => {
    const e = eixo(rel({ phone: { count: 31, pct: 5, at: [] } }), "phone");
    assert.equal(e.state, "alert", "count vira segundos: o passo antigo era sempre 1 s");
    assert.match(e.detail, /não medida/, "e a tela avisa que a sequência não foi medida");
});

test("eixo AUSENTE do relatório é 'não analisado', diferente de 'ok'", () => {
    const eixos = evaluate(rel({ phone: { count: 0, at: [] } }));
    const mãos = eixos.find(e => e.key === "hands");
    assert.equal(mãos.state, "unanalyzed");
    assert.match(mãos.detail, /não analisado/);
    assert.equal(hasAlert(eixos), false, "não analisado não conta como alerta");
});

test("ausência e +1 pessoa seguem por percentual", () => {
    assert.equal(eixo(rel({ absent: { count: 60, pct: 25, at: [] } }), "absent").state, "alert");
    assert.equal(eixo(rel({ absent: { count: 10, pct: 5, at: [] } }), "absent").state, "ok");
    assert.equal(eixo(rel({ multiple_people: { count: 60, pct: 22, at: [] } }), "multiple_people").state, "alert");
});

test("cobertura parcial vira aviso sobre o próprio relatório", () => {
    assert.equal(coverageWarning(rel({}, { truncated: false })), null);
    assert.match(
        coverageWarning(rel({}, { truncated: true, covered_s: 1200, video_duration_s: 2645 })),
        /1200 s de 2645 s/,
    );
});

test("relatório vazio não quebra", () => {
    assert.deepEqual(evaluate(null), []);
    assert.deepEqual(evaluate({}), []);
    assert.equal(hasAlert([]), false);
});

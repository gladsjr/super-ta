// Vigilância leve de posição ao vivo (#267, ADR 0021). Testa os miolos PUROS:
// a avaliação de pose e a máquina de estados (sustentação, benchmark, morte).
//
//   node --test tests/live-nudge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
await import("../static/js/liveNudge.js");
const { evaluatePose, createTracker } = globalThis.window.liveNudge;

// Pose sintética: 33 marcos "bons" (pessoa enquadrada, punhos à vista).
function goodPose() {
    const L = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
    L[0] = { x: 0.5, y: 0.25, visibility: 1 };   // nariz
    L[7] = { x: 0.45, y: 0.25, visibility: 1 };  // orelhas → largura de face 0.10
    L[8] = { x: 0.55, y: 0.25, visibility: 1 };
    L[11] = { x: 0.35, y: 0.55, visibility: 1 }; // ombros
    L[12] = { x: 0.65, y: 0.55, visibility: 1 };
    L[15] = { x: 0.40, y: 0.85, visibility: 1 }; // punhos
    L[16] = { x: 0.60, y: 0.85, visibility: 1 };
    return L;
}

test("pose boa passa", () => {
    assert.equal(evaluatePose(goodPose()).ok, true);
});

test("sem pose → orientação de aparecer na câmera", () => {
    const r = evaluatePose(null);
    assert.equal(r.ok, false);
    assert.match(r.guidance, /Apareça na câmera/);
});

test("cabeça cortada no topo (espaço sobrando acima) reprova", () => {
    const L = goodPose();
    L[0].y = 0.01; // nariz colado no topo = cabeça cortada
    const r = evaluatePose(L);
    assert.equal(r.ok, false);
    assert.match(r.guidance, /cabeça/);
});

test("punhos fora do quadro reprovam com a orientação de mãos", () => {
    const L = goodPose();
    L[15].visibility = 0.1; L[16].y = 1.0;
    const r = evaluatePose(L);
    assert.equal(r.ok, false);
    assert.match(r.guidance, /mãos visíveis/);
});

test("UM punho à vista basta para o aviso (aproximação, não veredito)", () => {
    const L = goodPose();
    L[15].visibility = 0.1; // só o direito visível
    assert.equal(evaluatePose(L).ok, true);
});

test("distância: perto/longe demais reprovam, com margem mais frouxa que o setup", () => {
    const L = goodPose();
    L[7].x = 0.30; L[8].x = 0.52; // faceW 0.22 > 0.16*1.15
    assert.match(evaluatePose(L).guidance, /Afaste-se/);
    L[7].x = 0.48; L[8].x = 0.52; // faceW 0.04 < 0.06*0.85
    assert.match(evaluatePose(L).guidance, /Aproxime-se/);
    L[7].x = 0.47; L[8].x = 0.53; // faceW 0.06: reprovaria no setup (== FACE_MIN), passa ao vivo
    assert.equal(evaluatePose(L).ok, true);
});

// ---- máquina de estados (relógio injetado) ----
const mk = () => createTracker({ badMs: 10000, okMs: 3000, budgetMs: 80, benchSamples: 3 });

test("10 s de inadequação sustentada pausam; piscada não", () => {
    const t = mk();
    let now = 0;
    assert.equal(t.feed({ ok: false, guidance: "x", now }).action, null);
    now += 5000; // 5 s inadequado, então corrige
    assert.equal(t.feed({ ok: true, now }).action, null);
    now += 1000; // recomeça a contagem do zero
    assert.equal(t.feed({ ok: false, guidance: "x", now }).action, null);
    now += 9000;
    assert.equal(t.feed({ ok: false, guidance: "x", now }).action, null, "9 s ainda não pausa");
    now += 1500;
    assert.equal(t.feed({ ok: false, guidance: "mãos", now }).action, "pause");
});

test("liberação exige posição correta SUSTENTADA (3 s), com progresso", () => {
    const t = mk();
    let now = 0;
    t.feed({ ok: false, guidance: "x", now });
    now += 10500;
    assert.equal(t.feed({ ok: false, guidance: "x", now }).action, "pause");
    now += 1000;
    t.feed({ ok: true, now });                          // 1º tick ok abre a contagem
    const meio = t.feed({ ok: true, now: now + 1500 }); // 1,5 s de ok sustentado
    assert.equal(meio.action, null);
    assert.ok(meio.okProgress > 0 && meio.okProgress < 1, "progresso parcial alimenta a contagem do modal");
    // recaída zera a sustentação
    assert.equal(t.feed({ ok: false, guidance: "x", now: now + 2000 }).action, null);
    const de_novo = now + 3000;
    t.feed({ ok: true, now: de_novo });
    assert.equal(t.feed({ ok: true, now: de_novo + 3100 }).action, "resume");
    assert.equal(t.state, "watching");
});

test("benchmark embutido: mediana acima do orçamento desliga a vigilância", () => {
    const t = mk();
    t.feed({ ok: true, inferMs: 120, now: 0 });
    t.feed({ ok: true, inferMs: 150, now: 2500 });
    t.feed({ ok: true, inferMs: 130, now: 5000 });
    assert.equal(t.state, "disabled");
    assert.equal(t.disabledReason, "desligado_por_desempenho");
    // desligada, nunca mais age
    assert.equal(t.feed({ ok: false, guidance: "x", now: 60000 }).action, null);
});

test("máquina rápida não desliga", () => {
    const t = mk();
    t.feed({ ok: true, inferMs: 20, now: 0 });
    t.feed({ ok: true, inferMs: 30, now: 2500 });
    t.feed({ ok: true, inferMs: 25, now: 5000 });
    assert.equal(t.state, "watching");
});

test("disable externo (watchdog de queda) mata na hora, com o motivo", () => {
    const t = mk();
    t.disable("desligado_apos_queda");
    assert.equal(t.state, "disabled");
    assert.equal(t.disabledReason, "desligado_apos_queda");
});

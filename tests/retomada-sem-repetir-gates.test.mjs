// Retomar não é recomeçar (#356) — e não é atalho para furar gate.
//
// A tela de queda promete "continuar de onde parou" e o fluxo mandava o aluno
// refazer o termo de consentimento e o sound check inteiro. Pedir de novo o
// aceite de um termo já aceito, no meio de uma avaliação, transforma o
// consentimento num clique reflexo para voltar à prova — que é o oposto de
// consentir. E refazer a captação segundos depois de uma queda de rede não mede
// nada novo: mesmo equipamento, mesma sala.
//
// O limite: sound check VERMELHO continua bloqueando (ADR 0023), e termo em
// versão nova continua sendo pedido. Estes testes fixam essa fronteira.
//
//   node --test tests/retomada-sem-repetir-gates.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fonte = (p) => fs.readFileSync(path.join(raiz, p), "utf8");

// A decisão do cliente, replicada aqui como função pura para poder exercitá-la.
// Espelha static/oral-student.html#prepararRetomada e o trecho equivalente do
// live-student. Se a regra mudar lá, este teste tem de mudar junto.
const JANELA_MS = 30 * 60 * 1000;
function decidir({ resuming, consent_ok, sound_check, sound_check_at }, agora = Date.now()) {
    if (!resuming || !consent_ok) return { pedirTermo: !consent_ok, pularSoundCheck: false };
    const medido = sound_check_at ? Date.parse(sound_check_at) : NaN;
    const fresco = Number.isFinite(medido) && (agora - medido) < JANELA_MS;
    return {
        pedirTermo: false,
        pularSoundCheck: !!(fresco && sound_check && sound_check.state !== "vermelho"),
    };
}

const agora = Date.parse("2026-09-01T12:00:00Z");
const minutosAtras = (m) => new Date(agora - m * 60000).toISOString();

test("queda há dois minutos: nem termo nem sound check de novo", () => {
    const d = decidir({
        resuming: true, consent_ok: true,
        sound_check: { state: "verde" }, sound_check_at: minutosAtras(2),
    }, agora);
    assert.equal(d.pedirTermo, false);
    assert.equal(d.pularSoundCheck, true, "o teste de som de 2 min atrás mede o mesmo equipamento");
});

test("meia hora depois, o som é medido de novo", () => {
    const d = decidir({
        resuming: true, consent_ok: true,
        sound_check: { state: "verde" }, sound_check_at: minutosAtras(31),
    }, agora);
    assert.equal(d.pularSoundCheck, false,
        "passou tempo: o aluno pode ter trocado de fone, de sala ou de rede");
});

test("sound check VERMELHO não é pulado, por mais recente que seja", () => {
    const d = decidir({
        resuming: true, consent_ok: true,
        sound_check: { state: "vermelho" }, sound_check_at: minutosAtras(1),
    }, agora);
    assert.equal(d.pularSoundCheck, false,
        "retomar não pode virar atalho para furar o bloqueio da ADR 0023");
});

test("termo em versão NOVA é pedido de novo, mesmo retomando", () => {
    const d = decidir({
        resuming: true, consent_ok: false,
        sound_check: { state: "verde" }, sound_check_at: minutosAtras(1),
    }, agora);
    assert.equal(d.pedirTermo, true, "termo novo é outro termo — o aceite anterior não vale para ele");
    assert.equal(d.pularSoundCheck, false);
});

test("primeira entrada não pula nada", () => {
    const d = decidir({ resuming: false, consent_ok: false, sound_check: null, sound_check_at: null }, agora);
    assert.equal(d.pedirTermo, true);
    assert.equal(d.pularSoundCheck, false);
});

test("sem carimbo de quando foi medido, refaz", () => {
    const d = decidir({ resuming: true, consent_ok: true, sound_check: { state: "verde" }, sound_check_at: null }, agora);
    assert.equal(d.pularSoundCheck, false, "sem saber QUANDO, não dá para afirmar que ainda vale");
});

test("o servidor expõe os dois estados nos dois fluxos de voz", () => {
    // Eles sempre existiram no banco; faltava chegarem à página, que sem isso
    // não tinha como decidir e entrava sempre pelo começo.
    for (const arquivo of ["routes/oralExam.js", "routes/interviewLive.js"]) {
        const txt = fonte(arquivo);
        assert.match(txt, /consent_ok:/, `${arquivo}: falta expor o consentimento (#356)`);
        assert.match(txt, /sound_check_at:/, `${arquivo}: falta expor QUANDO o som foi medido (#356)`);
        assert.match(txt, /resuming:/, `${arquivo}: falta distinguir retomada de primeira entrada`);
    }
});

test("as duas telas de voz respeitam a mesma janela", () => {
    // oral-student e live-student são quase-clones e já divergiram por cópia.
    for (const tela of ["static/oral-student.html", "static/live-student.html"]) {
        const txt = fonte(tela);
        assert.match(txt, /SOUND_CHECK_VALIDO_MS = 30 \* 60 \* 1000/,
            `${tela}: a janela de validade precisa ser a mesma nas duas telas (#356)`);
        assert.match(txt, /state !== 'vermelho'/,
            `${tela}: vermelho não pode ser pulado (ADR 0023)`);
    }
});

test("o box da retranscrição existe mesmo sem retranscrição", () => {
    // #363: antes ele sumia, e a ausência não dizia nada — nem ao aluno nem ao
    // professor, que não sabia se estava a caminho, se falhou, ou se não haveria.
    assert.match(fonte("static/oral-student.html"), /em andamento/,
        "aluno: o box precisa mostrar o estado de espera");
    const prof = fonte("static/oral-conversation.html");
    assert.ok(!/if \(!ft \|\| \(!ft\.text && !ft\.segments\)\) return;/.test(prof),
        "professor: o box não pode mais sumir em silêncio (#363)");
    assert.match(prof, /em andamento/, "professor: precisa dizer que a retranscrição vem depois");
});

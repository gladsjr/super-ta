// Escada do sound check v2 (#288, ADR 0023) — regras puras de lib/soundCheck.js.
import test from "node:test";
import assert from "node:assert/strict";
import { ladderState, countEchoMatches, parseHfp, soundCheckPending, soundCheckProgress, scriptLeakMatches, SC_SCRIPTS, SCRIPT_LEAK_MIN, HARD_WER } from "../lib/soundCheck.js";

const att = (wer) => ({ attempt: 1, wer, missed: [], text: "x" });

test("countEchoMatches", async (t) => {
    await t.test("acha os marcadores mesmo com pontuação/caixa", () => {
        assert.equal(countEchoMatches("Girassol! e o... LABIRINTO."), 2);
    });
    await t.test("silêncio/vazio = zero", () => {
        assert.equal(countEchoMatches(""), 0);
        assert.equal(countEchoMatches(null), 0);
    });
    await t.test("alucinação típica de silêncio não pontua", () => {
        assert.equal(countEchoMatches("Obrigado por assistir. Legendas pela comunidade."), 0);
    });
    await t.test("plural simples conta", () => {
        assert.equal(countEchoMatches("girassóis não, mas trombones e veleiros sim"), 2); // trombone+s, veleiro+s
    });
});

test("ladderState — casos da escada", async (t) => {
    await t.test("sem nenhuma medição -> null (fail-open)", () => {
        assert.equal(ladderState(null), null);
        assert.equal(ladderState({}), null);
    });
    await t.test("leitura aprovada limpa -> verde", () => {
        const s = ladderState({ passed: true, attempts: 1, worst_wer: 0.1, transcripts: [att(0.1)] });
        assert.equal(s.state, "verde");
    });
    await t.test("caso Rebeca: leitura ok + eco 1x -> amarelo; eco 2x -> vermelho", () => {
        const base = { passed: true, attempts: 1, worst_wer: 0.2, transcripts: [att(0.2)] };
        assert.equal(ladderState({ ...base, echo: { leaks_recent: [true] } }).state, "amarelo");
        assert.equal(ladderState({ ...base, echo: { leaks_recent: [true, true] } }).state, "vermelho");
    });
    await t.test("caso George: reprovação dura na 1ª + aprovado na 2ª -> amarelo (pior resultado registrado)", () => {
        const s = ladderState({ passed: true, attempts: 2, worst_wer: 0.765, transcripts: [att(0.765), att(0.1)] });
        assert.equal(s.state, "amarelo");
    });
    await t.test("duas reprovações duras -> vermelho", () => {
        const s = ladderState({ passed: false, attempts: 2, worst_wer: 0.9, transcripts: [att(0.9), att(0.8)] });
        assert.equal(s.state, "vermelho");
        assert.equal(s.hard_fails, 2);
    });
    await t.test("reprovado sem ser duro -> amarelo, nunca vermelho", () => {
        const s = ladderState({ passed: false, attempts: 2, worst_wer: 0.4, transcripts: [att(0.35), att(0.4)] });
        assert.equal(s.state, "amarelo");
    });
    await t.test("recuperação: 2 leituras novas limpas apagam o vermelho (janela = últimas 2)", () => {
        const s = ladderState({ passed: true, attempts: 2, worst_wer: 0.9, transcripts: [att(0.9), att(0.8), att(0.1), att(0.05)] });
        assert.equal(s.state, "amarelo"); // pior resultado segue registrado (worst_wer)
        assert.equal(s.hard_fails, 0);
    });
    await t.test("recuperação do eco: teste novo limpo derruba p/ amarelo", () => {
        const base = { passed: true, attempts: 1, worst_wer: 0.1, transcripts: [att(0.1)] };
        const s = ladderState({ ...base, echo: { leaks_recent: [true, false] } });
        assert.equal(s.state, "amarelo");
        assert.equal(s.echo_leaks, 1);
    });
    await t.test("HFP suspeito sozinho -> amarelo (aviso, nunca bloqueio)", () => {
        const s = ladderState({ hfp: { suspect: true, label: "AirPods Hands-Free AG Audio" } });
        assert.equal(s.state, "amarelo");
    });
    await t.test("waived aparece no estado (o gate deixa passar)", () => {
        const s = ladderState({ passed: false, transcripts: [att(0.9), att(0.9)], waived_at: "2026-08-24T00:00:00Z" });
        assert.equal(s.state, "vermelho");
        assert.equal(s.waived, true);
    });
    await t.test("limiar duro é exatamente HARD_WER (inclusivo)", () => {
        assert.equal(ladderState({ passed: false, transcripts: [att(HARD_WER), att(HARD_WER)] }).state, "vermelho");
        assert.equal(ladderState({ passed: false, transcripts: [att(HARD_WER - 0.01), att(HARD_WER - 0.01)] }).state, "amarelo");
    });
});

test("soundCheckPending — o teste é obrigatório (adendo ADR 0023)", async (t) => {
    await t.test("nada medido -> pendente", () => {
        assert.equal(soundCheckPending(null), true);
        assert.equal(soundCheckPending({}), true);
    });
    await t.test("só leitura, sem eco -> pendente", () => {
        assert.equal(soundCheckPending({ passed: true, attempts: 1 }), true);
    });
    await t.test("leitura aprovada + eco feito -> concluído", () => {
        assert.equal(soundCheckPending({ passed: true, attempts: 1, echo: { tests: 1 } }), false);
    });
    await t.test("leitura reprovada mas tentativas esgotadas + eco -> concluído", () => {
        assert.equal(soundCheckPending({ passed: false, attempts: 2, echo: { tests: 1 } }), false);
    });
    await t.test("só eco, leitura não resolvida -> pendente", () => {
        assert.equal(soundCheckPending({ attempts: 1, passed: false, echo: { tests: 2 } }), true);
    });
    await t.test("liberação do professor destrava", () => {
        assert.equal(soundCheckPending({ waived_at: "2026-08-24T00:00:00Z" }), false);
    });
});

test("scriptLeakMatches — a voz-guia como sonda de eco (#321)", async (t) => {
    await t.test("roteiro voltando pelo mic = vazamento (>= SCRIPT_LEAK_MIN palavras distintivas)", () => {
        const n = scriptLeakMatches("é obrigatório usar fones de ouvido o microfone vira eco", SC_SCRIPTS.g3_fones);
        assert.ok(n >= SCRIPT_LEAK_MIN, `esperava >= ${SCRIPT_LEAK_MIN}, veio ${n}`);
    });
    await t.test("fala legítima do aluno não pontua (stopwords/curtas não contam)", () => {
        const n = scriptLeakMatches("eu acho que a resposta é a fotossíntese das plantas", SC_SCRIPTS.g3_fones);
        assert.ok(n < SCRIPT_LEAK_MIN, `veio ${n}`);
    });
    await t.test("silêncio/vazio = zero", () => {
        assert.equal(scriptLeakMatches("", SC_SCRIPTS.g1_intro), 0);
    });
});

test("soundCheckProgress — reentrada do wizard (#321)", async (t) => {
    await t.test("nada feito", () => {
        assert.deepEqual(soundCheckProgress(null), { leitura_done: false, echo_done: false });
    });
    await t.test("leitura aprovada + eco limpo no último teste", () => {
        const p = soundCheckProgress({ passed: true, attempts: 1, echo: { tests: 2, leaks_recent: [true, false] } });
        assert.deepEqual(p, { leitura_done: true, echo_done: true });
    });
    await t.test("eco testado mas ÚLTIMO com vazamento -> echo não resolvido", () => {
        const p = soundCheckProgress({ passed: true, attempts: 1, echo: { tests: 1, leaks_recent: [true] } });
        assert.equal(p.echo_done, false);
    });
});

test("parseHfp", async (t) => {
    await t.test("JSON válido vira registro saneado", () => {
        const h = parseHfp('{"suspect":true,"label":"Headset (HFP)","sample_rate":16000,"hi_ratio":0.0001}');
        assert.equal(h.suspect, true);
        assert.equal(h.sample_rate, 16000);
    });
    await t.test("lixo vira null", () => {
        assert.equal(parseHfp("{{{"), null);
        assert.equal(parseHfp(null), null);
        assert.equal(parseHfp('"só uma string"'), null);
    });
});

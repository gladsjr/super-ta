// Bloco de retranscrição de auditoria p/ avaliadores (#289, corte 4).
import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditBlock, auditPromptBlock } from "../lib/auditTranscript.js";

const FINAL_SEG = {
    mode: "segments",
    text: "resposta um\nresposta dois",
    segments: [
        { start_s: 10.2, end_s: 31.8, q_idx: 1, text: "resposta um" },
        { start_s: 40, end_s: 41, q_idx: 2, error: "too short" },
        { start_s: 65, end_s: 92.4, q_idx: 2, text: "resposta dois" },
        { start_s: 2, end_s: 5, q_idx: 0, text: "alô, teste" },
    ],
};

test("buildAuditBlock", async (t) => {
    await t.test("segments: uma linha por segmento OK, com tempo e posição", () => {
        const a = buildAuditBlock({ final: FINAL_SEG });
        assert.equal(a.mode, "segments");
        const lines = a.text.split("\n");
        assert.equal(lines.length, 3); // o segmento com error fica de fora
        assert.match(lines[0], /^\[0:10–0:32 · após a 1ª fala do examinador\] resposta um$/);
        assert.match(lines[2], /antes da 1ª fala do examinador\] alô, teste$/);
    });
    await t.test("multiPart: cai para o contínuo (posicional reinicia na retomada)", () => {
        const a = buildAuditBlock({ final: FINAL_SEG, multiPart: true });
        assert.equal(a.mode, "continuous");
        assert.equal(a.text, FINAL_SEG.text);
    });
    await t.test("continuous: texto direto", () => {
        const a = buildAuditBlock({ final: { mode: "continuous", text: "fala corrida" } });
        assert.equal(a.mode, "continuous");
        assert.equal(a.text, "fala corrida");
    });
    await t.test("too_large/ausente/vazio -> null", () => {
        assert.equal(buildAuditBlock({ final: { mode: "too_large", bytes: 99 } }), null);
        assert.equal(buildAuditBlock({ final: null }), null);
        assert.equal(buildAuditBlock({ final: { mode: "continuous", text: "  " } }), null);
    });
    await t.test("segments todos com erro -> cai para o texto (se houver)", () => {
        const a = buildAuditBlock({ final: { mode: "segments", segments: [{ q_idx: 1, error: "x" }], text: "restou isto" } });
        assert.equal(a.mode, "continuous");
        assert.equal(a.text, "restou isto");
    });
    await t.test("answers (modo mensagem, corte 4B): turno exato por resposta", () => {
        const a = buildAuditBlock({ final: { mode: "answers", text: "x", answers: [
            { audio_idx: 0, turn_index: 0, intervention_index: null, text: "primeira resposta" },
            { audio_idx: 1, turn_index: 1, intervention_index: 0, text: "réplica" },
            { audio_idx: 2, turn_index: 2, error: "falhou" },
        ] } });
        assert.equal(a.mode, "answers");
        const lines = a.text.split("\n");
        // A resposta que falhou era OMITIDA aqui, e o bloco saía com cara de
        // completo (#359). Como o prompt manda confiar nele como fonte de maior
        // fidelidade, a ausência era lida como "o aluno não disse nada" — e
        // virava nota. Agora a lacuna aparece marcada e é contada.
        assert.equal(lines.length, 3);
        assert.equal(lines[0], "[turno 0] primeira resposta");
        assert.equal(lines[1], "[turno 1 (intervenção)] réplica");
        assert.match(lines[2], /^\[turno 2\] \(esta resposta não pôde ser retranscrita/);
        assert.equal(a.lacunas, 1);
    });
    await t.test("humanLabels (#310): 1-based p/ gente; intro sem turno vira 'abertura'", () => {
        const a = buildAuditBlock({ final: { mode: "answers", text: "x", answers: [
            { audio_idx: 0, turn_index: null, text: "oi, sou o aluno" },
            { audio_idx: 1, turn_index: 0, text: "primeira resposta" },
        ] }, humanLabels: true });
        const lines = a.text.split("\n");
        assert.equal(lines[0], "[abertura] oi, sou o aluno");
        assert.equal(lines[1], "[turno 1] primeira resposta");
    });
});

test("auditPromptBlock", async (t) => {
    await t.test("null -> string vazia (concatena sem sujeira)", () => {
        assert.equal(auditPromptBlock(null), "");
    });
    await t.test("segments: instrui ancorar pelo conteúdo e legitima retomar assunto", () => {
        const s = auditPromptBlock(buildAuditBlock({ final: FINAL_SEG }));
        assert.match(s, /RETRANSCRIÇÃO DE AUDITORIA/);
        assert.match(s, /ancore pelo CONTEÚDO/);
        assert.match(s, /isso é legítimo/);
        assert.match(s, /resposta um/);
    });
    await t.test("continuous: avisa que não há atribuição por pergunta", () => {
        const s = auditPromptBlock(buildAuditBlock({ final: { mode: "continuous", text: "fala corrida" } }));
        assert.match(s, /não tem atribuição por pergunta/);
    });
});

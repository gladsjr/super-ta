// Falha do provedor não vira culpa do aluno nem nota silenciosa (#358, #359).
//
// Dois padrões distintos, e a diferença entre eles importa:
//
//   #358 — o aluno LEVA A CULPA. A OpenAI recusa a chamada e ele lê "não
//          consegui entender o áudio, tente gravar de novo". Ele regrava,
//          falha igual, e conclui que o problema é o microfone dele — no meio
//          de uma avaliação, sem ninguém a quem recorrer.
//
//   #359 — o RESULTADO parece válido e não é. Uma prova que não abre, o aluno
//          reclama. Uma prova avaliada sem as respostas dele passa por legítima
//          e vira nota. Ninguém reporta o que parece ter funcionado.
//
//   node --test tests/falhas-de-provedor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    isProviderQuotaError, erroFatalDoProvedor, mensagemParaOAluno,
    PROVIDER_QUOTA_MESSAGE, FALHA_INTERNA_MESSAGE,
} from "../lib/providerErrors.js";
import { buildAuditBlock, auditPromptBlock } from "../lib/auditTranscript.js";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fonte = (p) => fs.readFileSync(path.join(raiz, p), "utf8");

// ---------------------------------------------------------------- #358 ------

test("mensagem ao aluno: falta de saldo tem saída própria, o resto é genérico", () => {
    const saldo = new Error("You exceeded your current quota, please check your plan");
    assert.equal(mensagemParaOAluno(saldo), PROVIDER_QUOTA_MESSAGE);
    assert.match(mensagemParaOAluno(saldo), /professor/i, "precisa apontar quem resolve");

    const outro = new Error("ECONNRESET");
    assert.equal(mensagemParaOAluno(outro), FALHA_INTERNA_MESSAGE);
    assert.match(mensagemParaOAluno(outro), /não é o seu arquivo nem a sua conexão/i,
        "o aluno precisa saber que a culpa não é dele");
});

test("nenhuma mensagem ao aluno entrega texto técnico cru", () => {
    const cru = new Error("Request failed with status 500: {\"error\":{\"type\":\"server_error\"}}");
    const msg = mensagemParaOAluno(cru);
    assert.ok(!msg.includes("500") && !msg.includes("server_error"),
        "err.message é texto de log; na tela do aluno só confunde (#358)");
});

test("a falha de STT deixa de ser sempre 'tente gravar de novo'", () => {
    // O caminho de erro precisa separar as duas classes: regravar resolve
    // problema de captação, e não resolve falta de saldo.
    const txt = fonte("routes/interview.js");
    const bloco = txt.slice(txt.indexOf("STT failed"), txt.indexOf("STT failed") + 900);
    assert.match(bloco, /isProviderQuotaError/,
        "a falha de STT precisa distinguir recusa do provedor (#358)");
    assert.match(bloco, /Tente gravar de novo/,
        "e continuar pedindo regravação quando o problema é mesmo o áudio");
});

test("falha persistente do orquestrador não vira 'pode repetir?' infinito", () => {
    // ask_repeat não marca answered_at, então não conta para o teto de turnos:
    // sem um limite próprio, a insistência não termina nunca.
    const txt = fonte("routes/interview.js");
    assert.match(txt, /MAX_ORCHESTRATOR_FAILS/, "falta o teto de falhas seguidas (#358)");
    assert.match(txt, /orchestratorFailStreak = 0/, "a série precisa zerar no sucesso");
    assert.match(txt, /orchestrator_unavailable/, "e sair com recado quando estoura");
});

test("a preparação da entrevista simplificada não expõe erro cru", () => {
    const txt = fonte("routes/interviewLive.js");
    assert.ok(!/PREPARING\.set\(submissionId, \{ error: err\.message \}\)/.test(txt),
        "o error do PREPARING vai para a TELA do aluno via /live/prep-status (#358)");
    assert.match(txt, /mensagemParaOAluno/, "precisa traduzir antes de guardar");
});

// ---------------------------------------------------------------- #359 ------

test("erro fatal do provedor é distinguido do ruído do Realtime", () => {
    // Derrubar a arguição por ruído seria pior que o defeito original.
    for (const ruido of [
        { type: "invalid_request_error", message: "Item not found" },
        { code: "input_audio_buffer_commit_empty", message: "buffer too small" },
        { type: "invalid_request_error", message: "Cancellation failed: no active response" },
    ]) {
        assert.equal(erroFatalDoProvedor(ruido), false, `não pode ser fatal: ${JSON.stringify(ruido)}`);
    }
    for (const fatal of [
        { code: "insufficient_quota", message: "You exceeded your current quota" },
        { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key" },
        { type: "server_error", message: "The server had an error" },
    ]) {
        assert.equal(erroFatalDoProvedor(fatal), true, `precisa ser fatal: ${JSON.stringify(fatal)}`);
    }
    assert.equal(erroFatalDoProvedor(null), false);
    assert.equal(erroFatalDoProvedor({}), false);
});

test("o relay encerra quando o provedor falha COM a sessão em andamento", () => {
    // O #351 só tratava o erro ANTES da confirmação da sessão. Saldo que acaba
    // no meio voltava a ser "log e segue", com a conexão viva e muda.
    const txt = fonte("lib/realtimeBridge.js");
    assert.match(txt, /erroFatalDoProvedor\(m\.error\)/,
        "o erro pós-confirmação precisa ser classificado (#359)");
    assert.match(txt, /abortarPorProvedor/, "e encerrar com motivo próprio");
    assert.match(txt, /reason: "provider_error"/, "que a tela do aluno possa distinguir do fim normal");
});

test("transcrição que falha deixa marca, não silêncio", () => {
    const txt = fonte("lib/realtimeBridge.js");
    assert.match(txt, /input_audio_transcription\.failed/,
        "o evento de falha precisa ser tratado — era o buraco do C5 (#359)");
    assert.match(txt, /transcription_failures/,
        "e contado nos sinais de voz, para o professor ver antes de publicar");
});

test("sem transcrição salva, a sessão não é marcada como concluída", () => {
    const txt = fonte("lib/realtimeBridge.js");
    assert.match(txt, /transcriptPersistido/,
        "concluir sem transcrição gera avaliação sobre nada (#359)");
});

test("o bloco de auditoria anuncia as próprias lacunas", () => {
    const comLacuna = buildAuditBlock({ final: { mode: "answers", answers: [
        { audio_idx: 0, turn_index: 0, text: "respondi isso" },
        { audio_idx: 1, turn_index: 1, error: "stt falhou" },
    ] } });
    assert.equal(comLacuna.lacunas, 1);
    const prompt = auditPromptBlock(comLacuna);
    assert.match(prompt, /ATENÇÃO/, "o prompt precisa avisar que o bloco está incompleto");
    assert.match(prompt, /NÃO significa que o aluno ficou calado/i,
        "senão a instrução de 'confie neste bloco' faz ausência virar silêncio do aluno");

    const completo = buildAuditBlock({ final: { mode: "answers", answers: [
        { audio_idx: 0, turn_index: 0, text: "tudo certo" },
    ] } });
    assert.equal(completo.lacunas, 0);
    assert.ok(!auditPromptBlock(completo).includes("ATENÇÃO"),
        "sem lacuna, nada de aviso — ruído no prompt custa atenção do avaliador");
});

test("insumo que falhou não vira ausência legítima na avaliação", () => {
    const txt = fonte("lib/evaluationOps.js");
    const bloco = txt.slice(txt.indexOf("audio list failed") - 700, txt.indexOf("audio list failed") + 300);
    assert.match(bloco, /notReady/,
        "lista vazia por ERRO era indistinguível de trabalho em modo texto (#359)");
});

test("áudio do aluno perdido é registrado como erro, não como rotina", () => {
    const txt = fonte("routes/interview.js");
    assert.ok(!/log\.info\("AUDIO_STORE", `put no-op/.test(txt),
        "perder o áudio de uma avaliação não é evento informativo (#359)");
    assert.match(txt, /ÁUDIO DO ALUNO PERDIDO/, "precisa aparecer numa busca de log");
});

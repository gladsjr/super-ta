// Voz incompatível com o Realtime (#351).
//
// O acidente que originou isto: uma prova oral configurada com `nova` — voz que a
// TTS aceita e o Realtime não. A OpenAI recusou o `session.update` INTEIRO, e a
// arguição rodou com a personalidade padrão do provedor, em inglês, sem as
// questões e sem a ferramenta de encerramento. O relay só registrou uma linha de
// log: nem o aluno nem o professor foram avisados.
//
//   node --test tests/realtime-voice.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    VOICES, isValidVoice, isRealtimeVoice, voicesFor, FALLBACK_VOICE,
} from "../config/voices.js";

test("as vozes que a OpenAI recusou no Realtime estão marcadas", () => {
    // A mensagem de erro da OpenAI listou as aceitas; nova e onyx ficaram de fora.
    assert.equal(isRealtimeVoice("nova"), false);
    assert.equal(isRealtimeVoice("onyx"), false);
});

test("as vozes citadas como suportadas continuam disponíveis", () => {
    for (const v of ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin"]) {
        assert.equal(isRealtimeVoice(v), true, `${v} deveria servir ao Realtime`);
    }
});

test("incompatível com Realtime ainda é voz válida para TTS", () => {
    // O catálogo continua servindo aos dois usos; o que mudou é saber distinguir.
    assert.equal(isValidVoice("nova"), true);
    assert.equal(isValidVoice("onyx"), true);
});

test("a lista para Realtime não contém as incompatíveis", () => {
    const ids = voicesFor({ realtime: true }).map(v => v.id);
    assert.ok(!ids.includes("nova"));
    assert.ok(!ids.includes("onyx"));
    assert.ok(ids.includes("coral"));
});

test("a lista sem filtro continua com o catálogo inteiro", () => {
    assert.equal(voicesFor().length, VOICES.length);
    assert.equal(voicesFor({ realtime: false }).length, VOICES.length);
});

test("o fallback serve ao Realtime", () => {
    // Se o fallback fosse incompatível, o remédio reproduziria a doença.
    assert.equal(isRealtimeVoice(FALLBACK_VOICE), true);
});

test("toda voz declara se serve ao Realtime", () => {
    for (const v of VOICES) {
        assert.equal(typeof v.realtime, "boolean", `${v.id} sem a marca realtime`);
    }
});

test("as vozes em uso em produção são compatíveis", () => {
    // Levantadas em 31/08/2026 nos works realtime: coral, ash, sage, shimmer e
    // uma sem voz (fallback). Nenhuma prova precisou ser migrada.
    for (const v of ["coral", "ash", "sage", "shimmer"]) {
        assert.equal(isRealtimeVoice(v), true);
    }
});

test("valores estranhos não passam por voz de Realtime", () => {
    for (const v of [null, undefined, "", "NOVA", "coral ", 42, {}]) {
        assert.equal(isRealtimeVoice(v), false);
    }
});

// ---------------------------------------------------------------------------
// As invariantes do relay
// ---------------------------------------------------------------------------
// `bridge()` abre um WebSocket real com a OpenAI, então não dá para exercitá-la
// aqui sem uma casca de mock que seria mais frágil que o próprio código. O que
// estas verificações protegem é a ORDEM que o acidente expôs — e falham alto se
// alguém reintroduzir o padrão antigo numa refatoração.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const relay = readFileSync(join(raiz, "lib", "realtimeBridge.js"), "utf8");

function blocoDoOpen(src) {
    const i = src.indexOf('oai.on("open"');
    assert.notEqual(i, -1, "handler de open sumiu do relay");
    const j = src.indexOf('oai.on("message"', i);
    return src.slice(i, j === -1 ? i + 4000 : j);
}

test("a 1ª fala NÃO é pedida junto com o session.update", () => {
    // Este era o bug: os dois saíam juntos, então a rejeição da configuração
    // chegava depois de o modelo já ter sido mandado falar.
    const abertura = blocoDoOpen(relay);
    assert.ok(
        !/type:\s*"response\.create"/.test(abertura),
        'O handler de open voltou a enviar "response.create" direto. A 1ª fala tem de ' +
        "esperar session.updated (ou o timeout) — senão uma configuração recusada " +
        "produz arguição com o agente padrão da OpenAI, em inglês (#351)."
    );
});

test("o relay reage a session.updated", () => {
    assert.match(relay, /case "session\.updated"/,
        "sem tratar session.updated, a confirmação nunca chega e tudo depende do timeout");
});

test("erro antes da confirmação encerra a sessão", () => {
    assert.match(relay, /abortarPorConfigRecusada/,
        "o caminho de aborto por configuração recusada sumiu");
    const i = relay.indexOf('case "error"');
    assert.notEqual(i, -1);
    const bloco = relay.slice(i, i + 500);
    assert.match(bloco, /sessionConfirmada/,
        'O "case error" voltou a tratar todo erro igual. Antes da confirmação, erro = ' +
        "session.update recusado, e a sessão precisa MORRER — deixar o agente padrão " +
        "conduzir a arguição é pior do que não abrir (#351).");
});

test("o aluno é avisado de que foi problema técnico", () => {
    assert.match(relay, /reason:\s*"config_rejeitada"/,
        "o cliente distingue 'ended' normal de queda técnica pelo reason; sem ele o " +
        "aluno vê a prova terminar como se fosse o fim natural");
});

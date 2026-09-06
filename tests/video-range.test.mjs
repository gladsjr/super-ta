// Entrega de vídeo com HTTP Range (#349).
//
// Dois alvos:
//
//  1. parseRange — a aritmética do cabeçalho, incluindo o sufixo "bytes=-N" que
//     a implementação antiga interpretava errado (lia como start=0).
//
//  2. O PASSTHROUGH da SDK do Replit. `@replit/object-storage@1.0.0` repassa o
//     `options` de downloadAsStream direto para o createReadStream do GCS, que
//     aceita { start, end }. Isso NÃO é documentado pela SDK: se uma atualização
//     parar de repassar, o vídeo volta a ser lido inteiro na memória e a VM volta
//     a correr risco de OOM — silenciosamente. Este teste é o alarme.
//     NÃO REMOVA sem substituir por outra prova do repasse.
//
//   node --test tests/video-range.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseRange, videoMimeFromKey } from "../lib/serveMedia.js";

const require = createRequire(import.meta.url);

test("range simples", () => {
    assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=100-199", 1000), { start: 100, end: 199 });
});

test("range aberto no fim vai até o último byte", () => {
    assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
});

test("sufixo pede os ÚLTIMOS N bytes", () => {
    // A implementação antiga lia "bytes=-500" como start=0 e devolvia o começo
    // do arquivo — resposta errada, com status 206 mentindo que era o fim.
    assert.deepEqual(parseRange("bytes=-500", 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRange("bytes=-2000", 1000), { start: 0, end: 999 });
});

test("fim além do tamanho é truncado, não é erro", () => {
    assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
});

test("início além do tamanho é 416", () => {
    assert.deepEqual(parseRange("bytes=1000-", 1000), { erro: true });
    assert.deepEqual(parseRange("bytes=5000-6000", 1000), { erro: true });
});

test("cabeçalho ausente ou ilegível: sem range (serve inteiro)", () => {
    assert.equal(parseRange(undefined, 1000), null);
    assert.equal(parseRange("bytes=abc", 1000), null);
    assert.equal(parseRange("bytes=-", 1000), null);
    assert.equal(parseRange("items=0-10", 1000), null);
});

test("sem tamanho conhecido não há range possível", () => {
    assert.equal(parseRange("bytes=0-99", null), null);
    assert.equal(parseRange("bytes=0-99", 0), null);
});

test("tipo mime pela extensão da chave", () => {
    assert.equal(videoMimeFromKey("proctor-video/abc-1.webm"), "video/webm");
    assert.equal(videoMimeFromKey("oral-video/abc-1.mp4"), "video/mp4");
    assert.equal(videoMimeFromKey("x/y.m4a"), "video/mp4");
});

// ---------------------------------------------------------------------------
// O alarme do passthrough
// ---------------------------------------------------------------------------

test("a SDK do Replit repassa options ao createReadStream do GCS", () => {
    let fonte;
    try {
        fonte = require("fs").readFileSync(
            require.resolve("@replit/object-storage/dist/index.js"), "utf8");
    } catch {
        return; // SDK ausente (ambiente sem a dependência) — nada a verificar
    }
    const i = fonte.indexOf("downloadAsStream(objectName");
    assert.notEqual(i, -1, "downloadAsStream sumiu da SDK");
    const trecho = fonte.slice(i, i + 400);
    assert.match(
        trecho, /createReadStream\(\s*options\s*\)/,
        "A SDK deixou de repassar `options` ao createReadStream: downloadAsStream(key, {start,end}) " +
        "não faz mais range na origem. Sem isso, servir vídeo volta a exigir o objeto inteiro em " +
        "memória (#349). Reveja lib/audioStore.js:streamRange antes de publicar."
    );
});

test("o createReadStream do GCS aceita start/end", () => {
    let tipos;
    try {
        tipos = require("fs").readFileSync(
            require.resolve("@google-cloud/storage/build/cjs/src/file.d.ts"), "utf8");
    } catch {
        return;
    }
    assert.match(tipos, /start\?:\s*number/, "CreateReadStreamOptions perdeu `start`");
    assert.match(tipos, /end\?:\s*number/, "CreateReadStreamOptions perdeu `end`");
});

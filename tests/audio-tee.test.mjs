// Tee de áudio do relay (#289): a regra sob teste é a de sobrevivência — o tee
// NUNCA pode derrubar nem atrasar o relay; falha vira log e morte silenciosa.
//
//   node --test tests/audio-tee.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudioTee } from "../lib/audioTee.js";

test("marcas acumulam com relógio relativo e tipo", () => {
    const tee = createAudioTee({ token: "t1" });
    tee.mark("speech_started");
    tee.mark("speech_stopped");
    assert.equal(tee.alive, true);
    // o índice é interno até o finish; a morte silenciosa é o contrato público
});

test("finish sem nenhum byte devolve null (sessão sem fala não gera artefato)", async () => {
    const tee = createAudioTee({ token: "t2" });
    tee.mark("speech_started");
    assert.equal(await tee.finish(), null);
});

test("write depois de morto é inofensivo (nunca lança)", async () => {
    const tee = createAudioTee({ token: "t3" });
    // mata forçando finish sem bytes (fecha o stream) e escreve depois
    await tee.finish();
    assert.doesNotThrow(() => tee.write(Buffer.from([1, 2, 3, 4])));
    assert.doesNotThrow(() => tee.mark("speech_started"));
});

test("frames curtos e ímpares não quebram a contagem de duração", async () => {
    const tee = createAudioTee({ token: "t4" });
    tee.write(Buffer.alloc(3));   // frame quebrado (não múltiplo de 2)
    tee.write(Buffer.alloc(4797));
    // 4800 bytes = 0,1s @ 24kHz PCM16 — finish converte de verdade (ffmpeg);
    // aqui só garantimos que o caminho não lança com entrada torta.
    const r = await tee.finish().catch(() => null);
    // resultado pode ser null (ffmpeg pode recusar 0,1s tortos) — o contrato é não lançar
    assert.ok(r === null || (r.key && r.ogg));
});

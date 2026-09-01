// Upload de vídeo sem passar pela RAM (#357).
//
// O vídeo de proctoring chega por multer e vai ao object storage. Se em qualquer
// ponto desse caminho o arquivo virar Buffer, uma turma encerrando junto pode
// derrubar a VM — foi o incidente de 16/08/2026, com um vídeo de ~40 min numa
// máquina de 8 GB que hospeda o relay de voz no mesmo processo.
//
// O caminho tem DOIS pontos onde a memória pode voltar, e os dois já falharam:
//
//   1. o multer com memoryStorage (era o caso da entrevista por mensagem);
//   2. um `readFile` logo depois do multer em disco, para alimentar putAudio,
//      que só aceitava bytes (era o caso da prova oral e da simplificada — o
//      ganho do disco evaporava na linha seguinte).
//
// Por isso os testes de invariante abaixo leem o PRÓPRIO FONTE das rotas: eles
// não provam que o upload funciona (o primeiro teste faz isso), provam que
// ninguém reintroduziu a bufferização. Se um deles falhar, leia o #357 antes de
// "consertar" o teste.
//
//   node --test tests/video-upload-disco.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fonte = (p) => fs.readFileSync(path.join(raiz, p), "utf8");

test("putAudioFromFile sobe o arquivo e devolve tamanho e hash corretos", async () => {
    // Backend local num diretório temporário — precisa estar no env ANTES do
    // import, porque o adaptador resolve o backend uma vez, no load.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-357-"));
    process.env.AUDIO_STORE_BACKEND = "local";
    process.env.AUDIO_STORE_LOCAL_DIR = dir;
    const store = await import("../lib/audioStore.js");

    const origem = path.join(dir, "gravacao.webm");
    const bytes = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(origem, bytes);

    const r = await store.putAudioFromFile({
        key: "proctor-video/abc123-1.webm",
        filePath: origem,
        mimetype: "video/webm",
    });

    assert.equal(r.stored, true, r.reason);
    assert.equal(r.byte_size, bytes.length);
    assert.equal(r.sha256, crypto.createHash("sha256").update(bytes).digest("hex"),
        "o hash em streaming precisa bater com o hash do conteúdo inteiro");

    // O objeto tem que estar íntegro do outro lado.
    const lido = await store.readAllBytes("proctor-video/abc123-1.webm");
    assert.equal(Buffer.compare(lido, bytes), 0, "conteúdo gravado difere do original");

    fs.rmSync(dir, { recursive: true, force: true });
});

test("arquivo vazio não é armazenado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-357-"));
    process.env.AUDIO_STORE_LOCAL_DIR = dir;
    const store = await import("../lib/audioStore.js");
    const vazio = path.join(dir, "vazio.webm");
    fs.writeFileSync(vazio, "");
    const r = await store.putAudioFromFile({ key: "proctor-video/vazio.webm", filePath: vazio });
    assert.equal(r.stored, false);
    assert.equal(r.reason, "empty_file");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("os três fluxos gravam o vídeo em DISCO, não em memória", () => {
    // Cada rota declara seu próprio multer de vídeo. Nenhuma pode usar
    // memoryStorage: é o defeito C1, que sobreviveu por meses justamente por
    // estar em um dos três arquivos e não nos outros dois.
    for (const arquivo of ["routes/interview.js", "routes/oralExam.js", "routes/interviewLive.js"]) {
        const txt = fonte(arquivo);
        const decl = txt.match(/const videoUpload = multer\(\{[\s\S]{0,200}?\}\);/);
        assert.ok(decl, `${arquivo}: não achei a declaração de videoUpload`);
        assert.ok(!/memoryStorage/.test(decl[0]),
            `${arquivo}: videoUpload voltou a usar memoryStorage — ver #357`);
        assert.ok(/dest:/.test(decl[0]),
            `${arquivo}: videoUpload precisa de dest (arquivo temporário em disco)`);
    }
});

test("nenhuma rota de vídeo lê o arquivo inteiro para um Buffer antes de subir", () => {
    // O defeito A2: multer em disco seguido de readFile devolve o problema.
    for (const arquivo of ["routes/interview.js", "routes/oralExam.js", "routes/interviewLive.js"]) {
        const txt = fonte(arquivo);
        assert.ok(!/readFile\(req\.file\.path\)/.test(txt),
            `${arquivo}: lê o vídeo inteiro para a memória — use putAudioFromFile (#357)`);
    }
});

test("a SDK do Replit oferece uploadFromFilename", () => {
    // A correção inteira depende disto. Se a SDK remover o método, o adaptador
    // quebra em produção e em lugar nenhum antes — este teste é o alarme.
    const { Client } = require("@replit/object-storage");
    assert.equal(typeof Client.prototype.uploadFromFilename, "function",
        "@replit/object-storage perdeu uploadFromFilename — ver lib/audioStore.js");
});

test("o backend local implementa a mesma superfície", () => {
    // O contrato documentado no cabeçalho de audioStore.js precisa valer para os
    // dois backends, senão o dev local diverge silenciosamente da produção.
    const txt = fonte("lib/audioStore.js");
    const bloco = txt.match(/const localBackend = \{[\s\S]*?\n\};/);
    assert.ok(bloco, "não achei o localBackend");
    assert.ok(/async uploadFromFilename\(/.test(bloco[0]),
        "localBackend precisa de uploadFromFilename para espelhar o Replit");
});

// O áudio da resposta do aluno precisa TOCAR (#380).
//
// A rota servia o arquivo cru: sem `Content-Length`, sem `Accept-Ranges`, e
// ignorando o `Range` que o navegador manda. O Safari pede `bytes=0-1` ao abrir
// um elemento de mídia e espera `206`; recebendo `200` com o arquivo inteiro,
// desiste e mostra "Erro". O Chrome tolera e toca, mas sem duração — o player
// fica em `00:00/00:00`, porque o WebM do MediaRecorder não traz duração no
// cabeçalho e, sem Range, não há como ler o fim do arquivo.
//
// Mesmo defeito do #376, no caminho do áudio — que o `serveVideo` nunca cobriu.
// Aqui o tamanho é ainda mais fácil: `student_audio_artifacts.byte_size` já o
// tem desde o arquivamento, então não se mede nada.
//
//   node --test tests/audio-range.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-380-"));
process.env.AUDIO_STORE_BACKEND = "local";
process.env.AUDIO_STORE_LOCAL_DIR = dir;

const { serveMedia } = await import("../lib/serveMedia.js");
const store = await import("../lib/audioStore.js");

const CHAVE = "audio/teste-380/12.webm";
const BYTES = crypto.randomBytes(122 * 1024);   // o tamanho do caso relatado

// Sobe o objeto e um app que serve como a rota real: com o tamanho vindo do
// registro do artefato, não do storage.
async function subir({ tamanhoConhecido, mimetype = "audio/webm" }) {
    const tmp = path.join(dir, "a.webm");
    fs.writeFileSync(tmp, BYTES);
    const r = await store.putAudioFromFile({ key: CHAVE, filePath: tmp, mimetype: "audio/webm" });
    assert.equal(r.stored, true, r.reason);

    const app = express();
    app.get("/a", (req, res) => serveMedia(req, res, CHAVE, "teste", { tamanhoConhecido, mimetype }));
    const srv = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    return { base: `http://127.0.0.1:${srv.address().port}`, fechar: () => new Promise(r => srv.close(r)) };
}

test("o pedido do Safari (bytes=0-1) responde 206, não 200", async () => {
    // Era exatamente isto que produzia o "Erro" na tela do professor.
    const { base, fechar } = await subir({ tamanhoConhecido: BYTES.length });
    try {
        const r = await fetch(`${base}/a`, { headers: { Range: "bytes=0-1" } });
        assert.equal(r.status, 206, "o Safari exige 206 para tocar mídia");
        assert.equal(r.headers.get("content-range"), `bytes 0-1/${BYTES.length}`);
        assert.equal(r.headers.get("content-length"), "2");
        const corpo = Buffer.from(await r.arrayBuffer());
        assert.equal(corpo.length, 2, "e o corpo tem de ser a FAIXA, não o arquivo inteiro");
    } finally { await fechar(); }
});

test("sem Range, a resposta declara tamanho e aceita faixa", async () => {
    const { base, fechar } = await subir({ tamanhoConhecido: BYTES.length });
    try {
        const r = await fetch(`${base}/a`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-length"), String(BYTES.length),
            "sem Content-Length o player não sabe a duração — fica em 00:00");
        assert.equal(r.headers.get("accept-ranges"), "bytes",
            "sem este cabeçalho o navegador nem tenta pedir faixa");
    } finally { await fechar(); }
});

test("o fim do arquivo é alcançável — é de onde o WebM tira a duração", async () => {
    const { base, fechar } = await subir({ tamanhoConhecido: BYTES.length });
    try {
        const r = await fetch(`${base}/a`, { headers: { Range: "bytes=-512" } });
        assert.equal(r.status, 206);
        const inicio = BYTES.length - 512;
        assert.equal(r.headers.get("content-range"), `bytes ${inicio}-${BYTES.length - 1}/${BYTES.length}`);
        const corpo = Buffer.from(await r.arrayBuffer());
        assert.equal(Buffer.compare(corpo, BYTES.subarray(inicio)), 0);
    } finally { await fechar(); }
});

test("sem o tamanho no registro, ainda funciona — mede no storage", async () => {
    // byte_size é NOT NULL na prática, mas registro antigo ou corrompido não
    // pode derrubar a reprodução: cai no mesmo caminho do #376.
    const { base, fechar } = await subir({ tamanhoConhecido: null });
    try {
        const r = await fetch(`${base}/a`, { headers: { Range: "bytes=0-1" } });
        assert.equal(r.status, 206);
        assert.equal(r.headers.get("content-range"), `bytes 0-1/${BYTES.length}`);
    } finally { await fechar(); }
});

test("áudio é servido como ÁUDIO, não como vídeo", async () => {
    // Buraco que a primeira versão desta correção abriu e o teste não pegava: o
    // helper derivava o tipo da EXTENSÃO, e áudio e vídeo compartilham `.webm`.
    // A resposta saía `video/webm` para um arquivo de voz — o elemento <audio>
    // recebendo um tipo que não é o dele. Só apareceu ao bater na rota real.
    const { base, fechar } = await subir({ tamanhoConhecido: BYTES.length });
    try {
        for (const h of [{}, { Range: "bytes=0-1" }]) {
            const r = await fetch(`${base}/a`, { headers: h });
            assert.equal(r.headers.get("content-type"), "audio/webm",
                "o mimetype do artefato tem de prevalecer sobre a extensão");
        }
    } finally { await fechar(); }
});

test("sem mimetype informado, cai na extensão (caminho do vídeo)", async () => {
    const { base, fechar } = await subir({ tamanhoConhecido: BYTES.length, mimetype: null });
    try {
        const r = await fetch(`${base}/a`);
        assert.equal(r.headers.get("content-type"), "video/webm",
            "quem não informa o tipo mantém o comportamento anterior");
    } finally { await fechar(); }
});

test("as rotas de áudio passam o mimetype do artefato", () => {
    const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    for (const arquivo of ["routes/work.js", "routes/interview.js"]) {
        const txt = fs.readFileSync(path.join(raiz, arquivo), "utf8");
        assert.match(txt, /mimetype: artifact\.mimetype/,
            `${arquivo}: sem passar o mimetype, o áudio sai como video/webm (#380)`);
    }
});

test("nenhuma rota de mídia serve arquivo cru", () => {
    // A causa raiz, guardada onde ela nasceu: `stream.pipe(res)` logo depois de
    // `streamAudio` é o padrão que ignorava Range. Se voltar, o Safari volta a
    // errar — e ninguém percebe até um professor reclamar.
    const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    for (const arquivo of ["routes/work.js", "routes/interview.js"]) {
        const txt = fs.readFileSync(path.join(raiz, arquivo), "utf8");
        assert.ok(!/streamAudio\(artifact\.object_key\)/.test(txt),
            `${arquivo}: voltou a servir áudio sem Range — use serveMedia (#380)`);
    }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

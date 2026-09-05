// Vídeo antigo (sem tamanho registrado) precisa TOCAR (#376).
//
// Regressão do #349, que introduziu `object_sizes`: o tamanho passou a ser
// gravado no UPLOAD, então tudo que já estava no storage ficou sem ele — 78 dos
// 80 vídeos de produção. E sem tamanho o servidor respondia 200 cru, sem
// `Content-Length` e sem `Accept-Ranges`.
//
// O erro de avaliação que deixou isso passar (meu): documentei como "o seek
// degrada". Não degrada — o vídeo NÃO TOCA. O WebM do MediaRecorder não traz
// duração no cabeçalho, então o navegador precisa ler o FIM do arquivo para
// descobri-la; sem Range ele não chega lá e o player fica em HAVE_NOTHING, tela
// preta, sem erro. O professor não consegue revisar os indícios — que é o que a
// ADR 0017 exige antes de confirmar ou descartar uma suspeita.
//
//   node --test tests/video-legado-toca.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Backend local num diretório temporário — precisa estar no env ANTES do import.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oratia-376-"));
process.env.AUDIO_STORE_BACKEND = "local";
process.env.AUDIO_STORE_LOCAL_DIR = dir;

const { serveVideo } = await import("../lib/serveVideo.js");
const store = await import("../lib/audioStore.js");

// object_sizes vive no BANCO, e é ele que o serveVideo consulta. Em ESM não se
// substitui export de módulo, então o teste usa o banco de dev de verdade — com
// uma chave própria, apagada antes e depois. É também mais fiel: exercita o
// caminho completo (consulta → medição → gravação → nova consulta), que é
// justamente onde o defeito morava.
const db = await import("../lib/db.js");
const { pool } = await import("../auth.js");

// O banco pode não estar de pé (Postgres em Docker, no dev local). Sem esta
// checagem os casos que dependem dele FICAM PENDURADOS na conexão — e teste que
// trava é pior que teste que falha: some no meio da suíte e ninguém sabe se
// passou. Aqui se descobre em 3s e os casos viram `skip`, com o motivo dito.
// Os dois últimos casos (invariante de fonte e guarda da SDK) não tocam o banco
// e rodam sempre.
// A sonda usa um cliente PRÓPRIO, com prazo, e não o pool compartilhado — por
// dois motivos. O pool do `pg` não rejeita quando o servidor não existe: ele
// espera. E, pior, a tentativa pendente segura o loop de eventos, então o
// processo de teste não termina nem depois de todos os casos passarem. Tocando
// só um cliente descartável, o pool compartilhado permanece intocado (ele é
// preguiçoso: sem query, sem socket).
const { default: pg } = await import("pg");
const bancoOk = await (async () => {
    const sonda = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2500, max: 1 });
    try { await sonda.query("SELECT 1"); return true; }
    catch { return false; }
    finally { await sonda.end().catch(() => {}); }
})();
const semBanco = bancoOk ? false : { skip: "Postgres indisponível — suba o banco para exercitar object_sizes" };

const CHAVE = `proctor-video/teste-376-${crypto.randomBytes(6).toString("hex")}.webm`;
const BYTES = crypto.randomBytes(300 * 1024);

async function subirObjeto() {
    const tmp = path.join(dir, "fonte.webm");
    fs.writeFileSync(tmp, BYTES);
    const r = await store.putAudioFromFile({ key: CHAVE, filePath: tmp, mimetype: "video/webm" });
    assert.equal(r.stored, true, r.reason);
}

// Sobe um app que serve pelo mesmo caminho da rota real.
async function subirApp() {
    const app = express();
    app.get("/v", (req, res) => serveVideo(req, res, CHAVE, "teste"));
    const srv = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    return { base: `http://127.0.0.1:${srv.address().port}`, fechar: () => new Promise(r => srv.close(r)) };
}

test("legado sem tamanho: responde 206 com Content-Range correto", semBanco, async () => {
    await subirObjeto();
    // object_sizes VAZIO para esta chave — a condição de todo vídeo anterior à 080.
    await pool.query("DELETE FROM object_sizes WHERE object_key = $1", [CHAVE]);

    const { base, fechar } = await subirApp();
    try {
        const r = await fetch(`${base}/v`, { headers: { Range: "bytes=0-99" } });
        assert.equal(r.status, 206, "sem 206 o navegador não descobre a duração e não toca");
        assert.equal(r.headers.get("content-range"), `bytes 0-99/${BYTES.length}`);
        assert.equal(r.headers.get("accept-ranges"), "bytes");
        assert.equal(r.headers.get("content-length"), "100");
        const corpo = Buffer.from(await r.arrayBuffer());
        assert.equal(Buffer.compare(corpo, BYTES.subarray(0, 100)), 0, "a faixa devolvida tem de ser a pedida");
    } finally { await fechar(); }
});

test("a medição é GRAVADA — não se repete a cada requisição", semBanco, async () => {
    await subirObjeto();
    await pool.query("DELETE FROM object_sizes WHERE object_key = $1", [CHAVE]);

    const { base, fechar } = await subirApp();
    try {
        await fetch(`${base}/v`, { headers: { Range: "bytes=0-9" } });
        // Espera o gravar assíncrono assentar.
        await new Promise(r => setTimeout(r, 60));
        const gravado = await db.getObjectSize(CHAVE);
        assert.equal(gravado, BYTES.length,
            "o tamanho medido precisa ir para object_sizes, senão medimos de novo a cada acesso");
    } finally { await fechar(); }
});

test("sem Range, a resposta traz Content-Length e Accept-Ranges", semBanco, async () => {
    await subirObjeto();
    await pool.query("DELETE FROM object_sizes WHERE object_key = $1", [CHAVE]);

    const { base, fechar } = await subirApp();
    try {
        const r = await fetch(`${base}/v`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-length"), String(BYTES.length),
            "era isto que faltava nos vídeos antigos");
        assert.equal(r.headers.get("accept-ranges"), "bytes",
            "sem este cabeçalho o navegador nem tenta pedir faixa");
    } finally { await fechar(); }
});

test("sufixo Range (os últimos bytes) funciona — é como o player busca a duração", semBanco, async () => {
    // O caso que importa para o WebM: ler o FIM do arquivo, onde estão os Cues.
    await subirObjeto();
    await pool.query("DELETE FROM object_sizes WHERE object_key = $1", [CHAVE]);

    const { base, fechar } = await subirApp();
    try {
        const r = await fetch(`${base}/v`, { headers: { Range: "bytes=-1024" } });
        assert.equal(r.status, 206);
        const inicio = BYTES.length - 1024;
        assert.equal(r.headers.get("content-range"), `bytes ${inicio}-${BYTES.length - 1}/${BYTES.length}`);
        const corpo = Buffer.from(await r.arrayBuffer());
        assert.equal(Buffer.compare(corpo, BYTES.subarray(inicio)), 0);
    } finally { await fechar(); }
});

test("a sonda de tamanho existe para os dois backends", () => {
    // No local é um stat; no Replit depende de uma via não pública da SDK
    // (ver o comentário em audioStore.js#objectSize). Se ela sumir, o vídeo
    // legado volta a não tocar — por isso o guarda logo abaixo.
    const txt = fs.readFileSync(new URL("../lib/audioStore.js", import.meta.url), "utf8");
    const fn = txt.slice(txt.indexOf("export async function objectSize"));
    assert.ok(!/BACKEND_NAME !== "local"\) return null;/.test(fn.slice(0, 400)),
        "objectSize voltou a desistir fora do backend local — é o defeito do #376");
});

test("a via da SDK que mede o objeto no Replit continua existindo", async () => {
    // Dependência NÃO PÚBLICA, e é deliberada: nada no contrato publicado
    // devolve o tamanho (`list()` só traz `name`; `downloadAsStream` canaliza
    // por um PassThrough que descarta os cabeçalhos do GCS). O que sobra é
    // `getBucket()` — marcado `private` no TypeScript, o que não existe em
    // runtime — e o `getMetadata()` do File, que é um HEAD barato.
    //
    // Este teste é o alarme: se uma atualização da SDK renomear o método, ele
    // falha aqui em vez de o vídeo legado voltar a não tocar em produção, em
    // silêncio. NÃO REMOVA sem substituir a garantia.
    const { Client } = await import("@replit/object-storage");
    assert.equal(typeof Client.prototype.getBucket, "function",
        "@replit/object-storage perdeu getBucket — ver lib/audioStore.js#objectSize (#376)");

    const { Storage } = await import("@google-cloud/storage");
    const file = new Storage().bucket("b").file("k");
    assert.equal(typeof file.getMetadata, "function",
        "o File do @google-cloud/storage perdeu getMetadata — é de onde sai o tamanho");
});

test.after(async () => {
    // A chave é só do teste; sai do banco e do disco sem deixar rastro.
    // O `pool.end()` também pendura quando a conexão nunca subiu — por isso só
    // é chamado quando houve banco, e ainda assim com prazo.
    if (bancoOk) {
        await pool.query("DELETE FROM object_sizes WHERE object_key = $1", [CHAVE]).catch(() => {});
        await Promise.race([pool.end().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

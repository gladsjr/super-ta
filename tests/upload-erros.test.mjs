// Arquivo acima do teto vira resposta que o aluno entende (#357).
//
// Sem tratamento, o MulterError virava página de erro 500 e o cliente oferecia
// "recarregue a página" — que apaga a gravação, porque ela só existe na aba do
// aluno. Aqui sobe um Express de verdade com o wrapper e confere o contrato que
// o cliente consome: status 413, corpo JSON, e uma orientação que NÃO manda
// recarregar.
//
//   node --test tests/upload-erros.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import multer from "multer";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { comErroTratado } from "../lib/uploadErrors.js";

// Sobe o app numa porta efêmera e devolve a base URL + como derrubar.
async function subir(app) {
    const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    return { base: `http://127.0.0.1:${srv.address().port}`, fechar: () => new Promise(r => srv.close(r)) };
}

function appDeTeste(limiteBytes) {
    const app = express();
    const up = multer({ dest: os.tmpdir(), limits: { fileSize: limiteBytes } });
    app.post("/video", comErroTratado(up.single("file"), "TESTE"), (req, res) => {
        if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
        res.json({ ok: true, bytes: req.file?.size ?? 0 });
    });
    return app;
}

async function enviar(base, bytes) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "video/webm" }), "prova.webm");
    const r = await fetch(`${base}/video`, { method: "POST", body: form });
    return { status: r.status, corpo: await r.json().catch(() => null) };
}

test("arquivo dentro do limite passa normalmente", async () => {
    const { base, fechar } = await subir(appDeTeste(1024 * 1024));
    try {
        const { status, corpo } = await enviar(base, Buffer.alloc(1024, 7));
        assert.equal(status, 200);
        assert.equal(corpo.ok, true);
        assert.equal(corpo.bytes, 1024);
    } finally { await fechar(); }
});

test("arquivo acima do teto responde 413 em JSON, não 500 em HTML", async () => {
    const { base, fechar } = await subir(appDeTeste(4 * 1024));
    try {
        const { status, corpo } = await enviar(base, Buffer.alloc(64 * 1024, 7));
        assert.equal(status, 413, "excesso de tamanho precisa ser 413, não 500");
        assert.ok(corpo, "a resposta precisa ser JSON — o cliente faz r.json()");
        assert.equal(corpo.error, "arquivo_grande_demais");
        assert.match(corpo.detail, /professor/i, "precisa apontar a saída real: falar com o professor");
        assert.doesNotMatch(corpo.detail, /recarregue a página para/i,
            "não pode mandar recarregar: isso apaga a gravação, que só existe na aba do aluno");
    } finally { await fechar(); }
});

test("a orientação de recarregar não voltou às telas do aluno", () => {
    // O texto antigo aparecia em oral-student e live-student. Guarda contra
    // reintrodução por cópia entre as duas telas, que são quase-clones.
    const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    for (const tela of ["static/oral-student.html", "static/live-student.html"]) {
        const txt = fs.readFileSync(path.join(raiz, tela), "utf8");
        assert.ok(!/Recarregue a página para tentar de novo/.test(txt),
            `${tela}: voltou a mandar o aluno recarregar depois de falha no envio (#357)`);
    }
});

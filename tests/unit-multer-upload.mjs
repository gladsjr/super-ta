// Smoke test do upload via multer — garante que o bump 1.x → 2.x (que trocou o
// dicer pelo busboy) não quebrou os fluxos de upload do app. Cobre os DOIS modos
// de storage usados em produção e a aplicação de limites:
//
//  - memoryStorage + limits  → req.file.buffer (enunciado, entrega do aluno,
//    áudio do chat, PDF da prova oral, PDFs de cenário)
//  - dest (disco) + limits   → req.file.path (VÍDEO da prova oral, até 300MB)
//  - limite de tamanho       → MulterError LIMIT_FILE_SIZE
//
// Não usa a OpenAI nem o banco: monta apps Express mínimos com as MESMAS configs
// de multer do app e faz POST multipart real. Uso: node tests/unit-multer-upload.mjs

import express from "express";
import multer from "multer";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail = "") {
    if (cond) console.log(`  ✓ ${name}`);
    else { console.log(`  ✗ ${name} ${detail}`); failures++; }
}

// Configs espelhando o app (routes/work.js, interview.js, oralExam.js).
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const diskUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();

// memoryStorage: como enunciado/entrega/prova-oral-PDF (.single("file"))
app.post("/mem", memUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    res.json({
        buffer: Buffer.isBuffer(req.file.buffer),
        size: req.file.size,
        name: req.file.originalname,
        mime: req.file.mimetype,
    });
});

// disco: como o VÍDEO da prova oral (dest → req.file.path)
app.post("/disk", diskUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const exists = fs.existsSync(req.file.path);
    const size = exists ? fs.statSync(req.file.path).size : -1;
    res.json({ pathGiven: !!req.file.path, exists, size, name: req.file.originalname, mime: req.file.mimetype });
    if (req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
});

// aplicação de limite: erro tratável (padrão do app — checar err.code)
app.post("/limited", (req, res) => {
    memUpload.single("file")(req, res, (err) => {
        if (err) return res.status(413).json({ code: err.code, name: err.name });
        res.json({ ok: true, size: req.file?.size });
    });
});

function form(bytes, filename, type) {
    const f = new FormData();
    f.append("file", new Blob([bytes], { type }), filename);
    return f;
}

async function main() {
    const multerVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "node_modules", "multer", "package.json"))).version;
    console.log(`multer em teste: ${multerVersion}`);
    check("multer é 2.x", multerVersion.startsWith("2."));

    const server = app.listen(0);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // PDF real se existir; senão bytes sintéticos (multer é agnóstico a conteúdo).
    const realPdf = "C:/Users/glads/Dropbox/Projetos/ORATIA/mineracao/Enunciado Trabalho Mineração Bitcoin - Cliente.pdf";
    const pdfBytes = fs.existsSync(realPdf) ? fs.readFileSync(realPdf) : Buffer.from("%PDF-1.4 fake\n".repeat(1000));

    // 1) memoryStorage
    {
        const r = await fetch(`${base}/mem`, { method: "POST", body: form(pdfBytes, "trabalho.pdf", "application/pdf") });
        const j = await r.json();
        check("mem: 200 OK", r.status === 200, `(status ${r.status})`);
        check("mem: req.file.buffer é Buffer", j.buffer === true);
        check("mem: size bate com o arquivo", j.size === pdfBytes.length, `(${j.size} vs ${pdfBytes.length})`);
        check("mem: originalname preservado", j.name === "trabalho.pdf", `(${j.name})`);
        check("mem: mimetype preservado", j.mime === "application/pdf", `(${j.mime})`);
    }

    // 2) disco (vídeo)
    {
        const vid = Buffer.alloc(256 * 1024, 7); // 256KB "vídeo"
        const r = await fetch(`${base}/disk`, { method: "POST", body: form(vid, "prova.webm", "video/webm") });
        const j = await r.json();
        check("disk: 200 OK", r.status === 200, `(status ${r.status})`);
        check("disk: req.file.path fornecido", j.pathGiven === true);
        check("disk: arquivo existe no disco", j.exists === true);
        check("disk: size no disco bate", j.size === vid.length, `(${j.size} vs ${vid.length})`);
        check("disk: mimetype preservado", j.mime === "video/webm", `(${j.mime})`);
    }

    // 3) limite de tamanho (6MB > 5MB)
    {
        const big = Buffer.alloc(6 * 1024 * 1024, 1);
        const r = await fetch(`${base}/limited`, { method: "POST", body: form(big, "grande.bin", "application/octet-stream") });
        const j = await r.json();
        check("limite: rejeita com 413", r.status === 413, `(status ${r.status})`);
        check("limite: código LIMIT_FILE_SIZE", j.code === "LIMIT_FILE_SIZE", `(${j.code})`);
    }

    // 4) sem campo de arquivo → handler devolve 400 (req.file ausente)
    {
        const r = await fetch(`${base}/mem`, { method: "POST", body: new FormData() });
        check("sem arquivo: 400", r.status === 400, `(status ${r.status})`);
    }

    server.close();
    console.log(failures === 0 ? "\n✅ TODOS OS TESTES DE UPLOAD PASSARAM" : `\n❌ ${failures} FALHA(S)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error("ERRO:", e); process.exit(1); });

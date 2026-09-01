// A aba do navegador mostra a marca ATUAL, em toda tela (#366).
//
// Dois defeitos separados: os arquivos de favicon eram a identidade ANTERIOR ao
// rebrand (uma coluna grega com livro e circuito, azul e dourado) e nove telas
// não declaravam favicon nenhum — três delas do aluno, justamente as que ele vê
// por mais tempo, numa avaliação valendo nota.
//
//   node --test tests/favicon.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const p = (...x) => path.join(raiz, ...x);

// student_instructions.html não é uma tela: é um FRAGMENTO injetado no modal de
// instruções (sem <head>). A issue #366 o listou por engano.
const FRAGMENTOS = new Set(["student_instructions.html"]);

test("toda tela declara o favicon", () => {
    const semIcone = fs.readdirSync(p("static"))
        .filter(f => f.endsWith(".html") && !FRAGMENTOS.has(f))
        .filter(f => !/rel="icon"/.test(fs.readFileSync(p("static", f), "utf8")));
    assert.deepEqual(semIcone, [],
        `sem favicon: ${semIcone.join(", ")} — o navegador cai no ícone genérico ou no cache (#366)`);
});

test("ninguém aponta para os arquivos da marca antiga", () => {
    // O nome mudou de propósito: o Chrome guarda favicon de forma agressiva e
    // não respeita bem o Cache-Control. Arquivo novo = nome novo, senão cada
    // usuário precisaria limpar o cache à mão.
    for (const f of fs.readdirSync(p("static")).filter(f => f.endsWith(".html"))) {
        const txt = fs.readFileSync(p("static", f), "utf8");
        assert.ok(!/favicon-(32|192)\.png/.test(txt),
            `${f}: aponta para o favicon anterior ao rebrand (#366)`);
    }
    assert.ok(!fs.existsSync(p("static/branding/favicon-32.png")), "o arquivo antigo devia ter saído");
    assert.ok(!fs.existsSync(p("static/branding/favicon-192.png")), "o arquivo antigo devia ter saído");
});

test("os ícones existem, são quadrados e têm o tamanho declarado", async () => {
    // Lê o cabeçalho IHDR do PNG (bytes 16..24) — sem depender de biblioteca.
    const dim = (arquivo) => {
        const b = fs.readFileSync(p(arquivo));
        assert.equal(b.subarray(1, 4).toString(), "PNG", `${arquivo} não é PNG`);
        return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    for (const [arquivo, lado] of [
        ["static/branding/favicon-32.v2.png", 32],
        ["static/branding/favicon-192.v2.png", 192],
        ["static/branding/apple-touch-icon.png", 180],
    ]) {
        const { w, h } = dim(arquivo);
        assert.equal(w, lado, `${arquivo}: largura`);
        assert.equal(h, lado, `${arquivo}: altura (favicon precisa ser quadrado)`);
    }
});

test("a raiz serve /favicon.ico", () => {
    // É onde o navegador procura sozinho quando a página não declara o ícone.
    // Os estáticos vivem só sob /static, então essa busca dava 404.
    const srv = fs.readFileSync(p("server.js"), "utf8");
    assert.match(srv, /app\.get\("\/favicon\.ico"/, "falta a rota de raiz (#366)");
});

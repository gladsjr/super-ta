// A marcação de avaliação parcial não pode derrubar o painel (#362).
//
// REGRESSÃO REAL, encontrada no teste integrado de 02/09/2026: a primeira versão
// desta marcação usava `(grades_json->'partial'->>'not_asked')::int` na consulta
// da listagem. Só que `grades_json` é TEXT — não jsonb, ao contrário das colunas
// vizinhas (oral_proctor_json, oral_voice_json, final_transcript). O Postgres
// respondeu "operator does not exist: text -> unknown", a consulta inteira
// falhou, e o painel do professor parou de abrir para TODOS os trabalhos.
//
// Duas lições, e os testes abaixo guardam as duas:
//
//   1. O tipo da coluna vizinha não prova o tipo desta. Nada em SQL deve tocar
//      grades_json com operador JSON — a leitura é em JS, como o resto do
//      arquivo já fazia.
//   2. Um adorno de uma linha não pode ter alcance de derrubar a listagem
//      inteira. Entrada inesperada vira 0, não exceção.
//
//   node --test tests/listagem-parcial.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { notAskedFromGrades } from "../lib/db/submissions.js";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("lê a contagem de questões não perguntadas", () => {
    const g = JSON.stringify({ criteria: [], partial: { not_asked: 2, scored: 3 } });
    assert.equal(notAskedFromGrades(g), 2);
});

test("prova completa não é marcada como parcial", () => {
    assert.equal(notAskedFromGrades(JSON.stringify({ criteria: [], partial: null })), 0);
    assert.equal(notAskedFromGrades(JSON.stringify({ criteria: [] })), 0,
        "formato anterior ao #362 não tem 'partial' — e isso é normal, não erro");
});

test("entrada inesperada vira 0, nunca exceção", () => {
    // Cada um destes derrubaria a listagem inteira se a leitura fosse em SQL.
    for (const entrada of [null, undefined, "", "isto não é json {{{", "[]", "42", '{"partial":"nao-e-objeto"}']) {
        assert.doesNotThrow(() => notAskedFromGrades(entrada), `entrada: ${JSON.stringify(entrada)}`);
        assert.equal(notAskedFromGrades(entrada), 0, `entrada: ${JSON.stringify(entrada)}`);
    }
});

test("valor não numérico não vaza para a tela", () => {
    assert.equal(notAskedFromGrades(JSON.stringify({ partial: { not_asked: "duas" } })), 0);
    assert.equal(notAskedFromGrades(JSON.stringify({ partial: { not_asked: null } })), 0);
});

test("nenhum SQL aplica operador JSON sobre grades_json", () => {
    // A causa raiz, guardada onde ela nasceu. `grades_json` é TEXT: `->` e `->>`
    // sobre ela quebram a consulta em tempo de execução, não em revisão.
    //
    // ESCOPO deliberado em lib/db (tabela `submissions`). O MESMO nome de coluna
    // existe em `scenario_runs` como **jsonb**, e ali `->>` está correto
    // (lib/scenarios/store.js) — é exatamente a armadilha que me pegou: o tipo
    // não vem do nome da coluna nem do vizinho, vem da tabela.
    const dir = path.join(raiz, "lib", "db");
    for (const arquivo of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
        const txt = fs.readFileSync(path.join(dir, arquivo), "utf8");
        assert.ok(!/grades_json\s*(->|#>)/.test(txt),
            `${arquivo}: grades_json é TEXT — operador JSON aí derruba a consulta (#362). Leia em JS.`);
    }
});

test("a listagem não devolve grades_json ao cliente", () => {
    // São ~1,4 KB por submissão que ninguém consome do outro lado; o payload já
    // carrega oral_proctor_json e oral_voice_json.
    const txt = fs.readFileSync(path.join(raiz, "lib", "db", "submissions.js"), "utf8");
    const inicio = txt.indexOf("export async function listSubmissionsForWork");
    // Até a próxima declaração de topo — janela fixa em caracteres quebra a cada
    // comentário que alguém acrescente no meio.
    const fim = txt.indexOf("\nexport ", inicio + 1);
    const fn = txt.slice(inicio, fim > 0 ? fim : undefined);
    assert.match(fn, /\{ grades_json, \.\.\.row \}/,
        "o texto de grades_json deve ser consumido e descartado na listagem");
});

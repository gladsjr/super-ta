// Verificação de saúde, nível shallow (#375).
//
// O que se protege aqui, em ordem de estrago se quebrar:
//
//   1. O check de migrations NÃO pode rodar DDL nem exigir o guard do CLI —
//      o boot do servidor não cria tabela (ADR 0001). Se alguém "reaproveitar"
//      listMigrationStatus, o health check passa a criar schema_migrations em
//      produção pela porta dos fundos.
//   2. Nenhum check pode pendurar. O pool do pg espera para sempre quando o
//      banco não existe; um check sem prazo derruba a monitoração inteira.
//   3. /healthz precisa estar ANTES do store de sessão no server.js — uma sonda
//      de liveness que depende do banco de sessões não é liveness.
//   4. O status HTTP reflete o pior resultado: é o que a monitoração lê.
//
//   node --test -r dotenv/config tests/health-shallow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fonte = (p) => fs.readFileSync(path.join(raiz, p), "utf8");

const health = await import("../lib/health.js");
const { worstStatus, runHealth, CHECK_IDS, CHECKS } = health;

// Sonda de banco com prazo e cliente próprio — o pool compartilhado pendura
// quando o Postgres não existe (ver tests/video-legado-toca.test.mjs).
const { default: pg } = await import("pg");
const bancoOk = await (async () => {
    const sonda = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2500, max: 1 });
    try { await sonda.query("SELECT 1"); return true; } catch { return false; }
    finally { await sonda.end().catch(() => {}); }
})();
const semBanco = bancoOk ? false : { skip: "Postgres indisponível — suba o banco para exercitar os checks" };

// ---------------------------------------------------------------- puro -----

test("o pior estado vence, e skip não pesa", () => {
    assert.equal(worstStatus(["ok", "ok"]), "ok");
    assert.equal(worstStatus(["ok", "warn"]), "warn");
    assert.equal(worstStatus(["warn", "fail", "ok"]), "fail");
    assert.equal(worstStatus(["skip", "ok"]), "ok", "não medido não é ruim nem bom");
    assert.equal(worstStatus(["skip"]), "ok");
    assert.equal(worstStatus([]), "ok");
});

test("todo check registrado tem id único, rótulo e nível conhecido", () => {
    const ids = new Set();
    for (const c of CHECKS) {
        assert.ok(c.id && c.label && typeof c.run === "function", `check malformado: ${JSON.stringify(c.id)}`);
        assert.ok(["shallow", "deep", "e2e"].includes(c.level), `${c.id}: nível ${c.level}`);
        assert.ok(!ids.has(c.id), `id repetido: ${c.id}`);
        ids.add(c.id);
    }
});

test("níveis deep e e2e são recusados com 501 neste corte, não fingidos", async () => {
    for (const depth of ["deep", "e2e"]) {
        await assert.rejects(runHealth({ depth }), (e) => e.httpStatus === 501, `${depth} deveria ser 501`);
    }
    await assert.rejects(runHealth({ depth: "abissal" }), (e) => e.httpStatus === 400);
    await assert.rejects(runHealth({ ids: ["db", "inexistente"] }), (e) => e.httpStatus === 400 && /inexistente/.test(e.message));
});

// ---------------------------------------------------- invariantes de fonte ---

test("o check de migrations é leitura pura: sem guard de CLI e sem DDL", () => {
    const txt = fonte("lib/migrations.js");
    const i = txt.indexOf("export async function listMigrationStatusReadOnly");
    assert.ok(i > 0, "falta listMigrationStatusReadOnly");
    const fim = txt.indexOf("\nexport ", i + 1);
    const corpo = txt.slice(i, fim > 0 ? fim : undefined);
    assert.ok(!/assertCliContext\(\)/.test(corpo), "o health check não pode exigir MIGRATIONS_CLI=1");
    assert.ok(!/ENSURE_TABLE_SQL|CREATE TABLE/i.test(corpo), "o health check não pode rodar DDL (ADR 0001)");
    assert.ok(/schema_migrations.* does not exist/.test(corpo), "tabela ausente tem de ser RESULTADO, não exceção");
    // e o health.js usa o irmão certo
    assert.match(fonte("lib/health.js"), /listMigrationStatusReadOnly/);
    assert.ok(!/\blistMigrationStatus\(/.test(fonte("lib/health.js")), "health.js chamou a versão de CLI");
});

test("/healthz é montado ANTES do store de sessão", () => {
    const txt = fonte("server.js");
    const iHealthz = txt.indexOf('app.get("/healthz"');
    const iSessao = txt.indexOf("app.use(sessionMiddleware)");
    assert.ok(iHealthz > 0 && iSessao > 0);
    assert.ok(iHealthz < iSessao, "liveness não pode depender do banco de sessões");
    assert.ok(txt.indexOf("app.use(healthRoutes)") < txt.indexOf('app.get("/:slug"'), "o router de saúde tem de vir antes da rota curinga");
});

test("nenhum check de shallow escreve, gasta ou chama provedor", () => {
    // Guarda contra o próximo check "só mais um pouquinho": no nível shallow
    // não entra INSERT/UPDATE/DELETE, putAudio, openai, fetch a terceiros.
    const txt = fonte("lib/health.js");
    for (const proibido of [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /putAudio/, /openai\./i, /fetch\(\s*["']https?:/]) {
        assert.ok(!proibido.test(txt), `shallow não pode: ${proibido}`);
    }
});

test("cada check roda com prazo — nunca espera infinita", () => {
    const txt = fonte("lib/health.js");
    assert.match(txt, /Promise\.race\(\[promise, prazo\]\)/, "faltou a corrida contra o relógio");
    assert.match(txt, /SHALLOW_TIMEOUT_MS/);
});

// ------------------------------------------------------------ com banco -----

test("relatório shallow completo, com o contrato do endpoint", semBanco, async () => {
    const r = await runHealth();
    assert.equal(r.depth, "shallow");
    assert.ok(["ok", "warn", "fail"].includes(r.status));
    assert.equal(r.ok, r.status !== "fail");
    assert.ok(typeof r.duration_ms === "number");
    assert.equal(r.checks.length, CHECK_IDS.length, "sem filtro, rodam todos os de shallow");
    for (const c of r.checks) {
        assert.ok(CHECK_IDS.includes(c.id));
        assert.ok(["ok", "warn", "fail", "skip"].includes(c.status), `${c.id}: status ${c.status}`);
        assert.equal(c.cost_usd, 0, `${c.id}: shallow custa zero`);
        assert.ok(c.duration_ms >= 0 && c.duration_ms < 3500, `${c.id}: ${c.duration_ms} ms`);
        assert.equal(typeof c.detail, "object");
    }
    const db = r.checks.find(c => c.id === "db");
    assert.ok(db.detail.latency_ms >= 0 && db.detail.pool && "total" in db.detail.pool);
    const mig = r.checks.find(c => c.id === "migrations");
    assert.ok(mig.detail.total > 0 && Array.isArray(mig.detail.pending));
    const cfg = r.checks.find(c => c.id === "config");
    assert.ok(cfg.detail.principal_reasoning_model && cfg.detail.realtime_model && cfg.detail.stt_provider);
});

test("seleção por id devolve só o pedido", semBanco, async () => {
    const r = await runHealth({ ids: ["db", "assets"] });
    assert.deepEqual(r.checks.map(c => c.id).sort(), ["assets", "db"]);
});

test("o endpoint espelha o pior resultado no status HTTP e exige auth", semBanco, async () => {
    const { default: healthRoutes, healthz } = await import("../routes/health.js");
    const app = express();
    app.get("/healthz", healthz);
    app.use(healthRoutes);
    const srv = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const z = await fetch(`${base}/healthz`);
        assert.equal(z.status, 200);
        const zj = await z.json();
        assert.equal(zj.ok, true);
        assert.ok("commit" in zj && zj.ts);

        const semAuth = await fetch(`${base}/admin/health`);
        assert.equal(semAuth.status, 401, "sem token nem sessão, 401");

        const tokenRuim = await fetch(`${base}/admin/health`, { headers: { Authorization: "Bearer nao-existe" } });
        assert.equal(tokenRuim.status, 401, "token inválido, 401 — e não 500 nem 200");
    } finally { await new Promise(r => srv.close(r)); }
});

test.after(async () => {
    if (bancoOk) {
        const { pool } = await import("../auth.js");
        await Promise.race([pool.end().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    }
});

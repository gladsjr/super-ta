// Verificação de saúde, nível shallow (#375).
//
// O que se protege aqui, em ordem de estrago se quebrar:
//
//   1. O check de schema NÃO pode rodar DDL nem exigir o guard do CLI (ADR
//      0001) — e NÃO pode usar o ledger `schema_migrations` como verdade: em
//      produção o Publish materializa o schema sem escrever nele (8 linhas no
//      ledger contra 80 migrations, medido em 07/09/2026). Ledger como verdade
//      = 503 permanente em produção.
//   2. Nenhum check pode pendurar, e prazo estourado não pode deixar pedido
//      pendurado no pool: os checks de banco vão por um pool próprio com prazo
//      de conexão e transação READ ONLY com statement_timeout.
//   3. Não medido não é ok: tabela ausente, banco fora, seleção vazia.
//   4. Autenticar exige banco; se o banco não responde à validação do token, a
//      resposta é o diagnóstico (503 em prazo), não um 500 nem espera sem fim.
//   5. /healthz precisa estar ANTES do store de sessão no server.js, e é
//      aberto: não conta o commit.
//   6. O status HTTP reflete o pior resultado: é o que a monitoração lê.
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
const { worstStatus, runHealth, CHECK_IDS, CHECKS, EXPECTED_SCHEMA, EXPECTED_SCHEMA_FULL, healthPool } = health;
const { diffExpected, readCatalog } = await import("../lib/schemaExpectations.js");
const { heartbeat } = await import("../lib/jobsHeartbeat.js");
const { pool } = await import("../auth.js");

// Sonda de banco com prazo e cliente próprio — o pool compartilhado pendura
// quando o Postgres não existe (ver tests/video-legado-toca.test.mjs).
const { default: pg } = await import("pg");
const bancoOk = await (async () => {
    const sonda = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2500, max: 1 });
    try { await sonda.query("SELECT 1"); return true; } catch { return false; }
    finally { await sonda.end().catch(() => {}); }
})();
const semBanco = bancoOk ? false : { skip: "Postgres indisponível — suba o banco para exercitar os checks" };

const check = (id) => CHECKS.find(c => c.id === id);
const semTabela = (t) => Object.assign(new Error(`relation "${t}" does not exist`), { code: "42P01" });

// ---------------------------------------------------------------- puro -----

test("o pior estado vence, e skip não pesa", () => {
    assert.equal(worstStatus(["ok", "ok"]), "ok");
    assert.equal(worstStatus(["ok", "warn"]), "warn");
    assert.equal(worstStatus(["warn", "fail", "ok"]), "fail");
    assert.equal(worstStatus(["skip", "ok"]), "ok", "não medido não é ruim nem bom");
    assert.equal(worstStatus(["skip"]), "ok");
    assert.equal(worstStatus([]), "ok");
});

test("todo check registrado tem id único, rótulo, nível conhecido e diz se usa banco", () => {
    const ids = new Set();
    for (const c of CHECKS) {
        assert.ok(c.id && c.label && typeof c.run === "function", `check malformado: ${JSON.stringify(c.id)}`);
        assert.ok(["shallow", "deep", "e2e"].includes(c.level), `${c.id}: nível ${c.level}`);
        assert.equal(typeof c.db, "boolean", `${c.id}: falta a marca db`);
        assert.ok(!ids.has(c.id), `id repetido: ${c.id}`);
        ids.add(c.id);
    }
});

test("níveis deep e e2e são recusados com 501; depth/ids ruins e seleção vazia, 400", async () => {
    for (const depth of ["deep", "e2e"]) {
        await assert.rejects(runHealth({ depth }), (e) => e.httpStatus === 501, `${depth} deveria ser 501`);
    }
    await assert.rejects(runHealth({ depth: "abissal" }), (e) => e.httpStatus === 400);
    await assert.rejects(runHealth({ ids: ["db", "inexistente"] }), (e) => e.httpStatus === 400 && /inexistente/.test(e.message));
    await assert.rejects(runHealth({ ids: [] }), (e) => e.httpStatus === 400 && /vazio/.test(e.message), "checks=,,, não pode virar relatório vazio com ok:true");
});

// ------------------------------------------ checks com banco simulado -----
// Os checks recebem `ctx.q`; um `q` falso basta para exercitar os ramos que
// só aparecem num banco quebrado — sem tocar em banco nenhum.

// Alcances do token completos, para os cenários de seeds que não tratam deles.
const SCOPES_OK = { rows: [{ key: "analytics", ttl_days: 30 }, { key: "health", ttl_days: 365 }] };
const ehConsultaDeAlcances = (sql) => /SELECT key, ttl_days FROM analytics_token_scopes/.test(sql);

test("seeds: memberships ausente não pode dar ok (admin_bootstrap nulo não é admin presente)", async () => {
    const q = async (sql) => {
        if (/FROM memberships/.test(sql)) throw semTabela("memberships");
        if (ehConsultaDeAlcances(sql)) return SCOPES_OK;
        return { rows: [{ n: 3 }] };
    };
    const r = await check("seeds").run({ q });
    assert.equal(r.status, "fail");
    assert.deepEqual(r.detail.missing, ["memberships"]);
    assert.equal(r.detail.admin_bootstrap, null);
});

test("seeds: tudo presente e admin existente é ok; sem admin é fail", async () => {
    const ok = await check("seeds").run({ q: async (sql) => ehConsultaDeAlcances(sql) ? SCOPES_OK : ({ rows: [{ n: 1 }] }) });
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.detail.token_scopes_missing, []);
    const semAdmin = await check("seeds").run({ q: async (sql) => ehConsultaDeAlcances(sql) ? SCOPES_OK : ({ rows: [{ n: /FROM memberships/.test(sql) ? 0 : 1 }] }) });
    assert.equal(semAdmin.status, "fail");
    assert.equal(semAdmin.detail.admin_bootstrap, false);
});

test("seeds: alcances do token ausentes ou parciais são fail — tabela com linhas não basta (revisão do #392)", async () => {
    // Tabela existe e tem linhas (count > 0), mas falta o alcance `health`.
    const parcial = async (sql) => ehConsultaDeAlcances(sql) ? ({ rows: [{ key: "analytics", ttl_days: 30 }] }) : ({ rows: [{ n: 1 }] });
    const r = await check("seeds").run({ q: parcial });
    assert.equal(r.status, "fail");
    assert.deepEqual(r.detail.token_scopes_missing, ["health"]);
    // Validade zerada também não vale: token nasceria expirado.
    const zerada = async (sql) => ehConsultaDeAlcances(sql) ? ({ rows: [{ key: "analytics", ttl_days: 30 }, { key: "health", ttl_days: 0 }] }) : ({ rows: [{ n: 1 }] });
    assert.deepEqual((await check("seeds").run({ q: zerada })).detail.token_scopes_missing, ["health"]);
    // Tabela ausente: acusada como ausente, sem consultar os alcances.
    const semTab = async (sql) => { if (/FROM analytics_token_scopes/.test(sql)) throw semTabela("analytics_token_scopes"); return { rows: [{ n: 1 }] }; };
    const r3 = await check("seeds").run({ q: semTab });
    assert.equal(r3.status, "fail");
    assert.ok(r3.detail.missing.includes("analytics_token_scopes"));
});

test("seeds: a seed de alcances é idempotente e reconcilia a tabela a partir do código", semBanco, async () => {
    const { seedTokenScopes } = await import("../auth.js");
    const { TOKEN_SCOPE_DEFS } = await import("../lib/db/analyticsTokens.js");
    await seedTokenScopes();
    await seedTokenScopes(); // duas vezes: sem erro, sem duplicar
    const { rows } = await pool.query(`SELECT key, name, ttl_days FROM analytics_token_scopes ORDER BY key`);
    assert.deepEqual(rows.map(r => [r.key, r.ttl_days]), TOKEN_SCOPE_DEFS.map(d => [d.key, d.ttl_days]));
    // Divergência é corrigida no próximo boot (validade mexida à mão volta).
    await pool.query(`UPDATE analytics_token_scopes SET ttl_days = 1 WHERE key = 'health'`);
    await seedTokenScopes();
    assert.equal((await pool.query(`SELECT ttl_days FROM analytics_token_scopes WHERE key = 'health'`)).rows[0].ttl_days, 365);
});

test("consent: submissions ausente é fail, não ok com contagem nula", async () => {
    const r = await check("consent").run({ q: async () => { throw semTabela("submissions"); } });
    assert.equal(r.status, "fail");
    assert.match(r.detail.reason, /submissions/);
});

test("jobs: pendente envelhecendo é aviso mesmo sem lease vencida nem falha", async () => {
    const seteDias = new Date(Date.now() - 7 * 86400000);
    const q = async () => ({ rows: [{ type: "video_analysis", status: "pending", n: 10, lease_vencida: 0, falhas_24h: 0, pendente_mais_antigo: seteDias }] });
    const r = await check("jobs").run({ q });
    assert.equal(r.status, "warn");
    assert.ok(r.detail.oldest_pending_min > 60 * 24 * 6);
    assert.ok(r.detail.warnings.some(w => /pendente há/.test(w)), JSON.stringify(r.detail.warnings));
});

test("jobs: executor ligado mas sem tique é aviso; com tique recente, ok", async () => {
    const q = async () => ({ rows: [] });
    const antes = { ...heartbeat };
    try {
        heartbeat.started_at = new Date(Date.now() - 3600_000);
        heartbeat.last_tick_at = new Date(Date.now() - 3600_000);
        const parado = await check("jobs").run({ q });
        assert.equal(parado.status, "warn");
        assert.ok(parado.detail.warnings.some(w => /executor sem tique/.test(w)));
        heartbeat.last_tick_at = new Date();
        const vivo = await check("jobs").run({ q });
        assert.equal(vivo.status, "ok");
        assert.ok(vivo.detail.runner.silent_s <= 1);
    } finally { Object.assign(heartbeat, antes); }
});

test("jobs: tabela ausente é fail", async () => {
    const r = await check("jobs").run({ q: async () => { throw semTabela("jobs"); } });
    assert.equal(r.status, "fail");
});

test("schema: só o que veio depois da linha de base é conferido — e a ausência vem com a origem e o que a tabela tem", async () => {
    // Pós-linha de base (080) a expectativa é a FK renomeada pela 081 (#389).
    assert.equal(EXPECTED_SCHEMA.baseline, "080");
    assert.ok(EXPECTED_SCHEMA.constraints.has("submissions.submissions_proctor_review_level_fkey"));
    assert.ok(EXPECTED_SCHEMA.columns.size < 50, "a linha de base tira o histórico do check");
    const catalogo = (constraints) => async (sql) => {
        if (/information_schema\.tables/.test(sql)) return { rows: [...EXPECTED_SCHEMA_FULL.tables.keys()].map(name => ({ name })) };
        if (/information_schema\.columns/.test(sql)) return { rows: [...EXPECTED_SCHEMA_FULL.columns.keys()].map(name => ({ name })) };
        if (/pg_indexes/.test(sql)) return { rows: [...EXPECTED_SCHEMA_FULL.indexes].map(([name, v]) => ({ name, table: v.table })) };
        if (/pg_constraint/.test(sql)) return { rows: constraints.map(name => ({ name })) };
        if (/schema_migrations/.test(sql)) return { rows: [] }; // ledger vazio, como em prod
        throw new Error(`sql inesperado: ${sql}`);
    };
    // prod de HOJE: tem a FK antiga? não — tem nenhuma; falta a nova
    const semNova = [...EXPECTED_SCHEMA_FULL.constraints.keys()].filter(c => c !== "submissions.submissions_proctor_review_level_fkey");
    const r = await check("migrations").run({ q: catalogo(semNova) });
    assert.equal(r.status, "fail");
    assert.equal(r.detail.missing.length, 1);
    const m = r.detail.missing[0];
    assert.equal(m.name, "submissions.submissions_proctor_review_level_fkey");
    assert.equal(m.migration, "081_rename_proctor_review_fkey.sql");
    assert.equal(m.table, "submissions");
    assert.ok(m.present_on_table.includes("submissions_pkey"), "diz o que a tabela TEM");
    assert.equal(r.detail.ledger.applied, 0, "o ledger vazio é informação, não o motivo do fail");
    // depois do Publish certo: ok, mesmo com ledger vazio
    const ok = await check("migrations").run({ q: catalogo([...EXPECTED_SCHEMA_FULL.constraints.keys()]) });
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.detail.missing, []);
    // tabela ANTERIOR à linha de base sumiu (submissions): não pode esconder
    // a FK nova — vira ausência de tabela (revisão do #391)
    const semSubmissions = async (sql) => {
        if (/information_schema\.tables/.test(sql)) return { rows: [...EXPECTED_SCHEMA_FULL.tables.keys()].filter(t => t !== "submissions").map(name => ({ name })) };
        return catalogo([...EXPECTED_SCHEMA_FULL.constraints.keys()])(sql);
    };
    const r2 = await check("migrations").run({ q: semSubmissions });
    assert.equal(r2.status, "fail");
    assert.deepEqual(r2.detail.missing.map(m => [m.kind, m.name]), [["table", "submissions"]]);
});

// ---------------------------------------------------- invariantes de fonte ---

test("o check de schema é leitura pura: sem guard de CLI e sem DDL, e o ledger não decide", () => {
    const txt = fonte("lib/migrations.js");
    const i = txt.indexOf("export async function listMigrationStatusReadOnly");
    assert.ok(i > 0, "falta listMigrationStatusReadOnly");
    const fim = txt.indexOf("\nexport ", i + 1);
    const corpo = txt.slice(i, fim > 0 ? fim : undefined);
    assert.ok(!/assertCliContext\(\)/.test(corpo), "o health check não pode exigir MIGRATIONS_CLI=1");
    assert.ok(!/ENSURE_TABLE_SQL|CREATE TABLE/i.test(corpo), "o health check não pode rodar DDL (ADR 0001)");
    const h = fonte("lib/health.js");
    assert.match(h, /listMigrationStatusReadOnly/);
    assert.ok(!/\blistMigrationStatus\(/.test(h), "health.js chamou a versão de CLI");
    assert.match(h, /diffExpected\(EXPECTED_SCHEMA/, "o status vem do catálogo, não do ledger");
});

test("/healthz é montado ANTES do store de sessão", () => {
    const txt = fonte("server.js");
    const iHealthz = txt.indexOf('app.get("/healthz"');
    const iSessao = txt.indexOf("app.use(sessionMiddleware)");
    assert.ok(iHealthz > 0 && iSessao > 0);
    assert.ok(iHealthz < iSessao, "liveness não pode depender do banco de sessões");
    assert.ok(txt.indexOf("app.use(healthRoutes)") < txt.indexOf('app.get("/:slug"'), "o router de saúde tem de vir antes da rota curinga");
});

test("nenhum check de shallow escreve, gasta, chama provedor, bloqueia o loop ou fura a transação RO", () => {
    // Guarda contra o próximo check "só mais um pouquinho": no nível shallow
    // não entra INSERT/UPDATE/DELETE, putAudio, openai, fetch a terceiros;
    // NENHUM processo filho no caminho de uma chamada (o spawnSync do git é
    // só no boot; lançar ffmpeg é do nível deep); e todo SQL de check passa
    // por ctx.q (transação READ ONLY + statement_timeout), nunca pelo pool do
    // app direto.
    const txt = fonte("lib/health.js");
    for (const proibido of [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /putAudio/, /openai\./i, /fetch\(\s*["']https?:/, /\bexecFile\(/, /\bexec\(/, /\bspawn\(/, /execSync/, /pool\.query\(/]) {
        assert.ok(!proibido.test(txt), `shallow não pode: ${proibido}`);
    }
    assert.match(txt, /START TRANSACTION READ ONLY/);
    assert.match(txt, /SET LOCAL statement_timeout/);
    assert.match(txt, /connectionTimeoutMillis: SHALLOW_TIMEOUT_MS/, "o pool do health precisa de prazo de conexão");
});

test("cada check roda com prazo — nunca espera infinita", () => {
    const txt = fonte("lib/health.js");
    assert.match(txt, /Promise\.race\(\[promise, prazo\]\)/, "faltou a corrida contra o relógio");
    assert.match(txt, /SHALLOW_TIMEOUT_MS/);
});

// ------------------------------------------------------------ com banco -----

test("relatório shallow completo, com o contrato do endpoint — e o dev migrado dá schema sem ausências", semBanco, async () => {
    const r = await runHealth();
    assert.equal(r.depth, "shallow");
    assert.ok(["ok", "warn", "fail"].includes(r.status));
    assert.equal(r.ok, r.status !== "fail");
    assert.ok(typeof r.duration_ms === "number");
    assert.equal(r.checks.length, CHECK_IDS.length, "sem filtro, rodam todos os de shallow");
    assert.deepEqual(r.checks.map(c => c.id), CHECK_IDS, "ordem do registro");
    for (const c of r.checks) {
        assert.ok(["ok", "warn", "fail", "skip"].includes(c.status), `${c.id}: status ${c.status}`);
        assert.equal(c.cost_usd, 0, `${c.id}: shallow custa zero`);
        assert.ok(c.duration_ms >= 0 && c.duration_ms < 3500, `${c.id}: ${c.duration_ms} ms`);
        assert.equal(typeof c.detail, "object");
    }
    const db = r.checks.find(c => c.id === "db");
    assert.ok(db.detail.latency_ms >= 0 && db.detail.pool && "waiting" in db.detail.pool);
    const mig = r.checks.find(c => c.id === "migrations");
    // O parser não pode ter alarme falso: o banco de dev é migrado por definição.
    assert.equal(mig.status, "ok", JSON.stringify(mig.detail.missing));
    assert.deepEqual(mig.detail.missing, []);
    assert.equal(mig.detail.baseline, "080");
    assert.ok(mig.detail.files >= 81);
    const cfg = r.checks.find(c => c.id === "config");
    assert.ok(cfg.detail.principal_reasoning_model && cfg.detail.realtime_model && cfg.detail.stt_provider);
    const assets = r.checks.find(c => c.id === "assets");
    assert.ok(!("ffmpeg" in assets.detail), "shallow não lança binário");
});

test("o parser inteiro contra o dev real: o banco migrado por definição dá zero ausências (guarda contra alarme falso)", semBanco, async () => {
    // Valida o REPLAY COMPLETO (não só o pós-linha de base): é o que garante
    // que mover a linha de base no futuro não herda um parser errado.
    const c = await healthPool.connect();
    try {
        const cat = await readCatalog((sql) => c.query(sql));
        assert.deepEqual(diffExpected(EXPECTED_SCHEMA_FULL, cat), []);
    } finally { c.release(); }
});

test("seleção por id devolve só o pedido", semBanco, async () => {
    const r = await runHealth({ ids: ["db", "assets"] });
    assert.deepEqual(r.checks.map(c => c.id).sort(), ["assets", "db"]);
});

test("pool do health: chamadas concorrentes serializam na única conexão e nada fica esperando", semBanco, async () => {
    const [a, b] = await Promise.all([runHealth({ ids: ["db"] }), runHealth({ ids: ["db"] })]);
    assert.equal(a.checks[0].status, b.checks[0].status);
    assert.equal(healthPool.waitingCount, 0);
    assert.ok(healthPool.totalCount <= 1);
});

test("prazo de conexão estourado é fail com motivo E cancela o pedido — nada pendurado no pool", semBanco, async () => {
    // Segura a única conexão do pool do health; o check tem de desistir no
    // prazo e, ao desistir, o pedido sai da fila (connectionTimeoutMillis).
    const preso = await healthPool.connect();
    try {
        const t0 = Date.now();
        const r = await runHealth({ ids: ["db", "jobs"] });
        const ms = Date.now() - t0;
        assert.ok(ms < 4500, `desistiu em ${ms} ms`);
        assert.equal(r.status, "fail");
        for (const c of r.checks) assert.match(c.detail.error, /não medido|conexão com o banco/);
        assert.equal(healthPool.waitingCount, 0, "pedido de conexão continuou na fila depois do prazo");
    } finally { preso.release(); }
});

test("prazo TOTAL do check estourado não devolve ao pool uma conexão ainda ocupada, e o check seguinte mede normalmente", semBanco, async () => {
    // Regressão da revisão do #388: statement_timeout vale por instrução; três
    // consultas de 1,2 s cabem cada uma no limite e somadas estouram o prazo
    // do check. O relatório volta, mas a transação continuava rodando na
    // conexão que já tinha sido devolvida ao pool.
    let pid = null, terminou = false;
    const lento = { id: "lento_teste", label: "lento", level: "shallow", db: true, run: async ({ q }) => {
        pid = (await q("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        for (let i = 0; i < 3; i++) await q("SELECT pg_sleep(1.2)");
        terminou = true;
        return { status: "ok", detail: {} };
    } };
    const depois = { id: "depois_teste", label: "depois", level: "shallow", db: true, run: async ({ q }) => {
        const r = await q("SELECT 1 AS um");
        return { status: r.rows[0].um === 1 ? "ok" : "fail", detail: {} };
    } };
    CHECKS.push(lento, depois);
    try {
        const t0 = Date.now();
        const r = await runHealth();
        assert.ok(Date.now() - t0 < 4500);
        const l = r.checks.find(c => c.id === "lento_teste");
        assert.equal(l.status, "fail");
        assert.match(l.detail.error, /prazo|estourado/);
        assert.equal(terminou, false, "o corpo do check ainda estava rodando quando o relatório voltou — é o cenário");
        const d = r.checks.find(c => c.id === "depois_teste");
        assert.equal(d.status, "ok", "o check seguinte não pode herdar a conexão ocupada");
        // A consulta órfã não pode continuar viva no servidor.
        const act = await pool.query("SELECT state, query FROM pg_stat_activity WHERE pid = $1", [pid]);
        assert.ok(!act.rows.some(x => x.state === "active" && /pg_sleep/.test(x.query)), `backend ${pid} ainda ativo: ${JSON.stringify(act.rows)}`);
        assert.equal(healthPool.waitingCount, 0);
        const de_novo = await runHealth({ ids: ["db"] });
        assert.equal(de_novo.checks[0].status, "ok", "o pool tem de se recuperar sozinho");
    } finally {
        CHECKS.splice(CHECKS.indexOf(lento), 1);
        CHECKS.splice(CHECKS.indexOf(depois), 1);
        await new Promise(r => setTimeout(r, 200));
    }
});

test("autenticação com o pool do APP saturado não enfileira nada nele, e com o pool do health preso responde 503 em prazo sem deixar pedido", semBanco, async () => {
    // Regressão da revisão do #388: a validação do token ia pelo pool do app,
    // sem prazo de conexão — cada chamada da monitoração deixava um pedido a
    // mais na fila enquanto o banco não voltava.
    const { default: healthRoutes } = await import("../routes/health.js");
    const app = express();
    app.use(healthRoutes);
    const srv = await new Promise(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const maxAntes = pool.options.max;
    let presoApp = null, presoHealth = null;
    try {
        // 1) pool do app com uma conexão, e ela presa: a autenticação não pode
        //    depender dele. Token inválido → 401 rápido, nada esperando.
        pool.options.max = 1;
        presoApp = await pool.connect();
        for (let i = 0; i < 2; i++) {
            const t0 = Date.now();
            const r = await fetch(`${base}/admin/health?checks=db`, { headers: { Authorization: "Bearer nao-existe" }, signal: AbortSignal.timeout(4500) });
            assert.equal(r.status, 401, `chamada ${i + 1}: ${r.status}`);
            assert.ok(Date.now() - t0 < 1500, "não pode esperar o pool do app");
            assert.equal(pool.waitingCount, 0, `chamada ${i + 1}: pedido pendurado no pool do app`);
        }
        presoApp.release(); presoApp = null;
        // 2) pool do health preso: 503 em prazo, e o pedido de conexão da
        //    autenticação sai da fila — duas vezes seguidas.
        presoHealth = await healthPool.connect();
        for (let i = 0; i < 2; i++) {
            const t0 = Date.now();
            const r = await fetch(`${base}/admin/health?checks=db`, { headers: { Authorization: "Bearer nao-existe" }, signal: AbortSignal.timeout(4500) });
            const ms = Date.now() - t0;
            assert.equal(r.status, 503, `chamada ${i + 1}: ${r.status}`);
            assert.ok(ms < 4000, `chamada ${i + 1}: ${ms} ms`);
            assert.equal(healthPool.waitingCount, 0, `chamada ${i + 1}: pedido pendurado no pool do health`);
        }
    } finally {
        presoApp?.release(); presoHealth?.release();
        pool.options.max = maxAntes;
        await new Promise(r => srv.close(r));
    }
});

test("endpoint: /healthz aberto e sem commit; sem auth 401; token ruim 401; checks vazio 400", semBanco, async () => {
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
        assert.ok(zj.ts);
        assert.ok(!("commit" in zj), "/healthz é aberto: não conta o commit");

        const semAuth = await fetch(`${base}/admin/health`);
        assert.equal(semAuth.status, 401, "sem token nem sessão, 401");

        const tokenRuim = await fetch(`${base}/admin/health`, { headers: { Authorization: "Bearer nao-existe" } });
        assert.equal(tokenRuim.status, 401, "token inválido, 401 — e não 500 nem 200");

        // Autenticação com o banco fora: 503 em prazo, com o diagnóstico
        // mínimo (db em fail) e sem relatório completo. Simulado no pool do
        // HEALTH, que é por onde a validação do token passa agora.
        const original = healthPool.connect;
        try {
            healthPool.connect = async () => { throw new Error("ECONNREFUSED (simulado)"); };
            const caido = await fetch(`${base}/admin/health`, { headers: { Authorization: "Bearer qualquer" } });
            assert.equal(caido.status, 503, "banco fora na validação do token é 503, não 500");
            const cj = await caido.json();
            assert.equal(cj.status, "fail");
            assert.equal(cj.checks[0].id, "db");
            assert.ok(cj.unauthenticated, "tem de dizer que o relatório completo não saiu");
            assert.ok(!("commit" in cj), "não autenticado não recebe o commit");

            healthPool.connect = () => new Promise(() => {});
            const t0 = Date.now();
            const pendurado = await fetch(`${base}/admin/health`, { headers: { Authorization: "Bearer qualquer" }, signal: AbortSignal.timeout(4500) });
            assert.equal(pendurado.status, 503);
            assert.ok(Date.now() - t0 < 4000, "validação pendurada tem de desistir no prazo");
        } finally { healthPool.connect = original; }

        const vazio = await fetch(`${base}/admin/health?checks=,,,`, { headers: { Authorization: "Bearer nao-existe" } });
        assert.equal(vazio.status, 401, "auth vem antes; com token válido seria 400 (coberto em runHealth)");

        // Alcance (migration 082): token de ANÁLISE não entra na saúde (403);
        // token de SAÚDE entra (200) e não entra na análise (403). Linhas
        // temporárias no banco de dev, removidas no finally.
        const crypto = await import("node:crypto");
        const mk = (scope) => { const txt = `teste_${scope}_${crypto.randomBytes(8).toString("hex")}`; return { txt, hash: crypto.createHash("sha256").update(txt).digest("hex") }; };
        const tA = mk("analytics"), tH = mk("health");
        try {
            await pool.query(`INSERT INTO analytics_tokens (token_hash, token_prefix, label, scope, expires_at) VALUES ($1, 'teste_tmp', 'teste', 'analytics', now() + interval '5 minutes'), ($2, 'teste_tmp', 'teste', 'health', now() + interval '5 minutes')`, [tA.hash, tH.hash]);
            const analise = await fetch(`${base}/admin/health?checks=config`, { headers: { Authorization: `Bearer ${tA.txt}` } });
            assert.equal(analise.status, 403, "token de análise não serve para saúde");
            assert.match((await analise.json()).error, /alcance/);
            const saude = await fetch(`${base}/admin/health?checks=config`, { headers: { Authorization: `Bearer ${tH.txt}` } });
            assert.equal(saude.status, 200, "token de saúde serve");
            assert.equal((await saude.json()).checks[0].id, "config");
            const vazioOk = await fetch(`${base}/admin/health?checks=,,,`, { headers: { Authorization: `Bearer ${tH.txt}` } });
            assert.equal(vazioOk.status, 400, "com token válido, seleção vazia é 400");
            // e o endpoint de análise recusa o token de saúde
            const { default: analyticsRoutes } = await import("../routes/analytics.js");
            const app2 = express(); app2.use(express.json()); app2.use(analyticsRoutes);
            const srv2 = await new Promise(ok => { const s2 = app2.listen(0, "127.0.0.1", () => ok(s2)); });
            try {
                const q = await fetch(`http://127.0.0.1:${srv2.address().port}/api/analytics/query`, { method: "POST", headers: { Authorization: `Bearer ${tH.txt}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1" }) });
                assert.equal(q.status, 403, "token de saúde não lê dados de aluno");
            } finally { await new Promise(r => srv2.close(r)); }
        } finally {
            await pool.query(`DELETE FROM analytics_tokens WHERE token_prefix = 'teste_tmp'`);
        }
    } finally { await new Promise(r => srv.close(r)); }
});

test.after(async () => {
    await Promise.race([healthPool.end().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    if (bancoOk) {
        await Promise.race([pool.end().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    }
});

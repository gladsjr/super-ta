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

test("depth/ids ruins e seleção vazia, 400; check de nível acima da profundidade, 400; e2e inclui os três níveis", async () => {
    await assert.rejects(runHealth({ depth: "abissal" }), (e) => e.httpStatus === 400);
    // e2e existe (corte 4b): pedir realtime_b com depth=deep é 400 apontando depth=e2e
    await assert.rejects(runHealth({ depth: "deep", ids: ["realtime_b"] }), (e) => e.httpStatus === 400 && /depth=e2e/.test(e.message));
    const e2e = await runHealth({ depth: "e2e", ids: ["config"] });
    assert.equal(e2e.depth, "e2e");
    assert.equal(e2e.cost_usd, 0);
    await assert.rejects(runHealth({ ids: ["db", "inexistente"] }), (e) => e.httpStatus === 400 && /inexistente/.test(e.message));
    await assert.rejects(runHealth({ ids: [] }), (e) => e.httpStatus === 400 && /vazio/.test(e.message), "checks=,,, não pode virar relatório vazio com ok:true");
    // Pedir um check deep com depth=shallow não é "pular": é 400 — um relatório
    // sem ele diria menos do que o robô pediu.
    await assert.rejects(runHealth({ ids: ["config", "responses"] }), (e) => e.httpStatus === 400 && /responses/.test(e.message) && /depth=deep/.test(e.message));
    // depth=deep inclui shallow: selecionar só um check shallow em deep é
    // válido e não gasta nada.
    const r = await runHealth({ depth: "deep", ids: ["config"] });
    assert.equal(r.depth, "deep");
    assert.deepEqual(r.checks.map(c => c.id), ["config"]);
    assert.equal(r.checks[0].level, "shallow");
    assert.equal(r.cost_usd, 0);
});

// ------------------------------------------------------------- deep -----

test("registro e2e: só a perna B, paga, com orçamento próprio, sem cliente de banco do health", async () => {
    const { E2E_CHECKS } = await import("../lib/healthE2e.js");
    assert.deepEqual(E2E_CHECKS.map(c => [c.id, c.level, c.paid, c.db]), [["realtime_b", "e2e", true, false]]);
    assert.ok(CHECK_IDS.includes("realtime_b"));
});

test("realtime_b: orçamento esgotado ou ausente → skip sem abrir o relay nem criar envio", async () => {
    let abriu = 0, criou = 0;
    const deps = { WebSocket: class { constructor() { abriu++; } }, ops: { limparSondasAntigas: async () => 0, criarSonda: async () => { criou++; return { id: 1, submission_token: "x" }; }, custoDaSonda: async () => ({ cost_usd: 0, events: 0 }), registrarEstimativa: async () => {} } };
    for (const orcamento of [null, { work_id: null }, { work_id: 7, exceeded: true, month_spent_usd: 1.1, monthly_budget_usd: 1 }]) {
        const r = await check("realtime_b").run({ deps, orcamento });
        assert.equal(r.status, "skip");
    }
    assert.equal(abriu + criou, 0, "nem envio nem socket sem orçamento");
});

test("realtime_b: cria envio de teste, escuta o relay e mede o primeiro som; sem fala é fail; recusa é fail; abort fecha", async () => {
    const { EventEmitter } = await import("node:events");
    const ordem = [];
    let estimativas = [];
    const ops = {
        limparSondasAntigas: async () => { ordem.push("limpar"); return 2; },
        criarSonda: async (_q, workId) => { ordem.push("criar"); return { id: 99, submission_token: "sonda-teste", work_id: workId }; },
        // 1ª leitura: o relay não mediu (fala cortada antes do response.done);
        // depois da estimativa, o ledger tem o evento.
        custoDaSonda: async () => estimativas.length ? ({ cost_usd: 0.0123, events: 1 }) : ({ cost_usd: 0, events: 0 }),
        registrarEstimativa: async (_q, x) => { estimativas.push(x); },
    };
    class FakeWS extends EventEmitter {
        constructor(url) { super(); FakeWS.url = url; FakeWS.last = this; this.fechado = 0; setTimeout(() => { this.emit("open"); FakeWS.roteiro?.(this); }, 5); }
        close() { this.fechado++; this.emit("close", 1000); }
    }
    const orcamento = { work_id: 7, exceeded: false, month_spent_usd: 0, monthly_budget_usd: 1 };
    // 1) examinador fala: eventos de estado, depois áudio binário
    FakeWS.roteiro = (ws) => {
        setTimeout(() => ws.emit("message", Buffer.from(JSON.stringify({ type: "state", state: "intro" })), false), 5);
        setTimeout(() => { for (let i = 0; i < 12; i++) ws.emit("message", Buffer.alloc(4800, 1), true); }, 30);
    };
    let r = await check("realtime_b").run({ deps: { WebSocket: FakeWS, ops, baseWs: "ws://fake", settleMs: 10 }, orcamento });
    assert.equal(r.status, "ok", JSON.stringify(r.detail));
    assert.equal(FakeWS.url, "ws://fake/s/sonda-teste/oral/relay");
    assert.deepEqual(ordem, ["limpar", "criar"], "limpa as sondas antigas ANTES de criar a nova");
    assert.ok(r.detail.first_audio_ms >= 0 && r.detail.audio_bytes === 12 * 4800);
    assert.equal(r.detail.probes_cleaned, 2);
    assert.equal(r.detail.billed_to_work, 7);
    assert.equal(r.cost_usd, 0.0123, "o custo vem do ledger");
    assert.equal(r.detail.cost_estimated, true, "fala cortada → o relay não mediu → estimativa gravada e marcada");
    assert.deepEqual(estimativas.map(e => [e.workId, e.submissionId, Math.round(e.audioSeconds * 10) / 10]), [[7, 99, 1.2]]);
    assert.ok(FakeWS.last.fechado >= 1, "fecha o socket ao terminar");
    // 2) relay recusa (close sem open) → fail com motivo
    class Recusa extends EventEmitter { constructor() { super(); setTimeout(() => this.emit("close", 1006), 5); } close() {} }
    r = await check("realtime_b").run({ deps: { WebSocket: Recusa, ops, baseWs: "ws://fake", settleMs: 10 }, orcamento });
    assert.equal(r.status, "fail");
    assert.match(r.detail.reason, /não aceitou/);
    // 3) abre mas o examinador não fala: abort do check fecha e é fail
    FakeWS.roteiro = null;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    r = await check("realtime_b").run({ deps: { WebSocket: FakeWS, ops, baseWs: "ws://fake", settleMs: 10 }, orcamento, signal: ac.signal });
    assert.equal(r.status, "fail");
    assert.match(r.detail.reason, /não falou/);
    assert.ok(r.detail.events.includes("abort:prazo do check"));
    assert.ok(FakeWS.last.fechado >= 1);
});

test("registro deep: dez checks, todos com orçamento próprio e sem cliente de banco do health", async () => {
    const { DEEP_CHECKS, DEEP_BUDGET_MS, estimateDeepCostUsd } = await import("../lib/healthDeep.js");
    assert.deepEqual(DEEP_CHECKS.map(c => c.id), ["budget", "storage", "responses", "stt", "tts", "vision", "sidecar", "retranscribe_local", "ffmpeg", "realtime_a"]);
    for (const c of DEEP_CHECKS) {
        assert.equal(c.level, "deep");
        assert.equal(c.budget_ms, DEEP_BUDGET_MS, `${c.id}: orçamento`);
        assert.equal(c.db, false, `${c.id}: deep não segura a conexão única do health`);
        assert.ok(CHECK_IDS.includes(c.id), `${c.id} tem de estar no registro geral`);
    }
    const est = estimateDeepCostUsd();
    assert.ok(est > 0 && est < 0.05, `estimativa de custo do deep: US$ ${est}`);
});

test("invariantes do deep: escreve só em chave própria e apaga; Realtime nunca gera resposta; STT e TTS pela porta do produto", () => {
    const txt = fonte("lib/healthDeep.js");
    // storage: chave própria, e o delete faz parte do RESULTADO (falha = fail)
    assert.match(txt, /const key = `health\/probe-/);
    assert.match(txt, /const del = await store\.deleteAudio\(key\);\s*if \(!del\.deleted\)/);
    // Realtime: session.update sim, response.create NUNCA (geraria fala e custo)
    assert.match(txt, /type: "session\.update"/);
    assert.ok(!/response\.create/.test(txt), "a perna A não pode pedir resposta ao Realtime");
    assert.match(txt, /buildSessionConfig\(/, "o session.update tem de ser o MESMO do relay");
    // portas únicas do produto
    assert.match(txt, /sttTranscribe\(/);
    assert.ok(!/audio\.transcriptions\.create/.test(txt), "STT só pela porta única (AGENTS.md)");
    assert.match(txt, /synthesizeSpeech\(/);
    // nada de DDL nem escrita em tabela
    for (const proibido of [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE FROM\b/, /\bCREATE\b/]) assert.ok(!proibido.test(txt), `deep não pode: ${proibido}`);
});

test("storage: falha ao apagar reprova o check, mesmo com put/size/range ok; ciclo completo é ok", async () => {
    const { Readable } = await import("node:stream");
    const fake = (delOk) => ({
        isAvailable: () => true,
        putAudio: async ({ key }) => ({ stored: true, key }),
        objectSize: async () => 1024,
        streamRange: async () => Readable.from([Buffer.alloc(100, 1)]),
        deleteAudio: async () => delOk ? { deleted: true } : { deleted: false, reason: "403 forbidden (simulado)" },
    });
    const ruim = await check("storage").run({ deps: { store: fake(false) } });
    assert.equal(ruim.status, "fail");
    assert.equal(ruim.detail.step, "delete");
    assert.match(ruim.detail.delete_reason, /403/);
    assert.match(ruim.detail.leftover, /^health\/probe-/);
    const bom = await check("storage").run({ deps: { store: fake(true) } });
    assert.equal(bom.status, "ok");
    assert.ok(bom.detail.delete_ms >= 0);
});

test("realtime_a: socket que fecha ou silencia não pendura — rejeita; o prazo (signal) fecha o socket", async () => {
    const { EventEmitter } = await import("node:events");
    class FakeWS extends EventEmitter {
        constructor(_url, _opts) { super(); FakeWS.last = this; this.fechado = 0; setTimeout(() => { this.emit("open"); this.emit("message", Buffer.from(JSON.stringify({ type: "session.created" }))); FakeWS.roteiro?.(this); }, 5); }
        send() {}
        close() { this.fechado++; this.emit("close", 1000); }
    }
    const deps = { WebSocket: FakeWS, vozes: async () => ["verse"] };
    // 1) fecha logo depois do session.created, sem responder o update
    FakeWS.roteiro = (ws) => setTimeout(() => ws.emit("close", 1006), 20);
    const t0 = Date.now();
    await assert.rejects(check("realtime_a").run({ deps, bancoLivre: Promise.resolve() }), /fechado/);
    assert.ok(Date.now() - t0 < 1500, "não pode esperar o prazo do check");
    // 2) silêncio: o prazo do check (signal) fecha o socket e a espera rejeita
    FakeWS.roteiro = null;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(check("realtime_a").run({ deps, bancoLivre: Promise.resolve(), signal: ac.signal }), /prazo/);
    assert.ok(FakeWS.last.fechado >= 1, "o socket tem de ser fechado no abort");
    // 3) caminho feliz com o fake: updated para a voz
    FakeWS.roteiro = (ws) => { ws.send = () => setTimeout(() => ws.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" }))), 5); };
    const ok = await check("realtime_a").run({ deps, bancoLivre: Promise.resolve() });
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.detail.voices.map(v => [v.voice, v.ok]), [["verse", true]]);
});

test("deep em andamento (esperando provedor) NÃO segura a conexão do health: shallow concorrente responde", semBanco, async () => {
    // Revisão do #394: a conexão única era devolvida só no fim do relatório —
    // um deep esperando o Responses dava 503 falso à monitoração.
    const lento = { id: "lento_ext_teste", label: "externo lento", level: "deep", db: false, budget_ms: 10_000, run: async () => { await new Promise(r => setTimeout(r, 2500)); return { status: "ok", detail: {} }; } };
    CHECKS.push(lento); CHECK_IDS.push(lento.id);
    try {
        const deep = runHealth({ depth: "deep", ids: ["db", lento.id] });
        await new Promise(r => setTimeout(r, 300));
        const t0 = Date.now();
        const shallow = await runHealth({ ids: ["db"] });
        const ms = Date.now() - t0;
        assert.equal(shallow.checks[0].status, "ok", JSON.stringify(shallow.checks[0].detail));
        assert.ok(ms < 2000, `shallow esperou ${ms} ms pela conexão presa pelo deep`);
        const r = await deep;
        assert.equal(r.status, "ok");
    } finally {
        CHECKS.splice(CHECKS.indexOf(lento), 1);
        CHECK_IDS.splice(CHECK_IDS.indexOf(lento.id), 1);
    }
});

test("deep: os checks externos só começam DEPOIS de a sequência de banco devolver o cliente; no shallow correm em paralelo", semBanco, async () => {
    // Medido em prod (08/09): o `db` deu warn com 2,5 s durante os spawns do
    // próprio deep. O número do banco tem de ser do banco.
    let clienteVisto = "nunca-rodou";
    const espiao = { id: "espiao_ext_teste", label: "espião", level: "deep", db: false, run: async (ctx) => { clienteVisto = ctx.client; return { status: "ok", detail: {} }; } };
    CHECKS.push(espiao); CHECK_IDS.push(espiao.id);
    try {
        await runHealth({ depth: "deep", ids: ["db", "seeds", espiao.id] });
        assert.equal(clienteVisto, null, "no deep, o externo só roda com o cliente de banco já devolvido");
    } finally {
        CHECKS.splice(CHECKS.indexOf(espiao), 1);
        CHECK_IDS.splice(CHECK_IDS.indexOf(espiao.id), 1);
    }
});

test("aquecimento do boot: o boot ESPERA por ele (com teto) antes de ligar a fila de vídeo; nunca lança; nada síncrono", async () => {
    const txt = fonte("lib/warmup.js");
    assert.ok(!/spawnSync|execSync/.test(txt), "aquecimento não pode bloquear o loop");
    // Ordem no server.js: listen já aconteceu; aquecimento ANTES da fila
    // (revisão do #395 — reinício com backlog reivindica no primeiro tique).
    const srv = fonte("server.js");
    const iAq = srv.indexOf("await warmUpNativeDeps(");
    const iFila = srv.indexOf("await initProctorQueue()");
    const iListen = srv.indexOf("server listening");
    assert.ok(iAq > 0 && iFila > 0 && iListen > 0);
    assert.ok(iListen < iAq && iAq < iFila, "listen → aquecimento (aguardado) → fila");
    // Comportamento com spawn injetado: resolve depois dos DOIS toques…
    const { EventEmitter } = await import("node:events");
    const { warmUpNativeDeps } = await import("../lib/warmup.js");
    const lancados = [];
    const spawnFake = (cmd, args) => { const p = new EventEmitter(); p.kill = () => {}; lancados.push(cmd); setTimeout(() => p.emit("close", 0), 30); return p; };
    const r = await warmUpNativeDeps({ spawn: spawnFake, python: "py-fake" });
    assert.deepEqual(lancados, ["ffmpeg", "py-fake"], "ffmpeg primeiro, depois python, em série");
    assert.equal(r.capped, false);
    assert.ok(r.ffmpeg.ok && r.python.ok);
    // …e um binário pendurado não segura a fila além do teto
    const pendurado = () => { const p = new EventEmitter(); p.kill = () => {}; return p; };
    const t0 = Date.now();
    const c = await warmUpNativeDeps({ spawn: pendurado, python: "py-fake", capMs: 200 });
    assert.equal(c.capped, true);
    assert.ok(Date.now() - t0 < 1000);
    // …e binário ausente (error) não lança
    const ausente = () => { const p = new EventEmitter(); p.kill = () => {}; setTimeout(() => p.emit("error", new Error("ENOENT")), 5); return p; };
    const a = await warmUpNativeDeps({ spawn: ausente, python: "py-fake" });
    assert.equal(a.ffmpeg.ok, false);
});

test("tela: entrar na aba Operações carrega SEMPRE shallow; deep só pelo botão com o seletor", () => {
    const html = fonte("static/admin.html");
    assert.match(html, /opsEstavaOculta\) loadHealth\('shallow'\)/, "entrada na aba tem de pedir shallow explicitamente");
    assert.match(html, /health-refresh'\)\.onclick = \(\) => loadHealth\(document\.getElementById\('health-depth'\)\.value/, "só o botão lê o seletor");
    const corpo = html.slice(html.indexOf("async function loadHealth("), html.indexOf("document.getElementById('health-refresh').onclick"));
    assert.ok(!/health-depth/.test(corpo), "loadHealth não pode ler o seletor por conta própria");
});

// ------------------------------------------ contabilidade e teto mensal -----

test("orçamento mensal: ok abaixo de 80%, aviso acima, fail em 100%, fail sem trabalho de saúde", async () => {
    const base = { work_id: 7, monthly_budget_usd: 1, exceeded: false };
    let r = await check("budget").run({ orcamento: { ...base, month_spent_usd: 0.3, pct: 0.3 } });
    assert.equal(r.status, "ok");
    r = await check("budget").run({ orcamento: { ...base, month_spent_usd: 0.85, pct: 0.85 } });
    assert.equal(r.status, "warn");
    r = await check("budget").run({ orcamento: { ...base, month_spent_usd: 1.0, pct: 1, exceeded: true } });
    assert.equal(r.status, "fail");
    r = await check("budget").run({ orcamento: { work_id: null, month_spent_usd: 0, monthly_budget_usd: 1, pct: 0, exceeded: false } });
    assert.equal(r.status, "fail");
    assert.match(r.detail.reason, /seedHealthWork/);
    r = await check("budget").run({});
    assert.equal(r.status, "fail", "sem leitura do banco, não se declara orçamento");
});

test("orçamento esgotado: os checks pagos viram skip SEM chamar o provedor; os gratuitos seguem", async () => {
    // Se qualquer um chamasse a OpenAI, este teste gastaria — e falharia por
    // rede/chave onde não há; o skip tem de vir ANTES da chamada.
    const esgotado = { orcamento: { work_id: 7, month_spent_usd: 1.2, monthly_budget_usd: 1, pct: 1.2, exceeded: true } };
    for (const id of ["responses", "stt", "tts"]) {
        const r = await check(id).run(esgotado);
        assert.equal(r.status, "skip", id);
        assert.match(r.detail.reason, /esgotado/);
        assert.equal(r.cost_usd, 0);
    }
    const livre = await check("retranscribe_local").run(esgotado);
    assert.equal(livre.status, "skip", "este é skip por outro motivo (motor api), não pelo orçamento");
});

test("healthBudgetStatus: soma o ledger do MÊS corrente do trabalho de saúde; sem trabalho, work_id nulo", async () => {
    const { healthBudgetStatus } = await import("../lib/healthDeep.js");
    const { HEALTH_MONTHLY_BUDGET_USD } = await import("../lib/config.js");
    const q = async (sql) => /FROM works/.test(sql) ? { rows: [{ id: 42 }] } : { rows: [{ spent: 0.25 }] };
    const o = await healthBudgetStatus(q);
    assert.equal(o.work_id, 42);
    assert.equal(o.month_spent_usd, 0.25);
    assert.equal(o.monthly_budget_usd, HEALTH_MONTHLY_BUDGET_USD);
    assert.equal(o.exceeded, 0.25 >= HEALTH_MONTHLY_BUDGET_USD);
    const sem = await healthBudgetStatus(async (sql) => /FROM works/.test(sql) ? { rows: [] } : { rows: [{ spent: 0 }] });
    assert.equal(sem.work_id, null);
    assert.equal(sem.month_spent_usd, 0);
    // a consulta do gasto olha o mês corrente, não o acumulado
    const sqls = [];
    await healthBudgetStatus(async (sql) => { sqls.push(sql); return /FROM works/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [{ spent: 0 }] }; });
    assert.ok(sqls.some(x => /date_trunc\('month', now\(\)\)/.test(x)), "a soma tem de ser do mês corrente");
});

test("seedHealthWork: cria uma vez, é idempotente, inativo, sem is_benchmark, e o índice parcial impede um segundo", semBanco, async () => {
    const { seedHealthWork } = await import("../auth.js");
    const id = await seedHealthWork();
    assert.equal(await seedHealthWork(), id);
    const w = (await pool.query(`SELECT is_health, is_active, is_benchmark, kind, budget_usd::float8 AS b FROM works WHERE id = $1`, [id])).rows[0];
    assert.equal(w.is_health, true);
    assert.equal(w.is_active, true, "ATIVO: o relay recusa trabalho inativo, e a perna B abre o relay como aluno");
    assert.equal(w.is_benchmark, false, "nunca pela chave de benchmark");
    const q = (await pool.query(`SELECT jsonb_array_length(oral_questions) AS n, question_count FROM works WHERE id = $1`, [id])).rows[0];
    assert.ok(q.n >= 3 && q.question_count === 3, "exame preparado para a sonda");
    // reconcilia: desativado à mão volta a ativo no boot seguinte
    await pool.query(`UPDATE works SET is_active = false WHERE id = $1`, [id]);
    await seedHealthWork();
    assert.equal((await pool.query(`SELECT is_active FROM works WHERE id = $1`, [id])).rows[0].is_active, true);
    assert.ok(w.b >= 100, "teto acumulado alto: o freio real é o mensal");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM works WHERE is_health`)).rows[0].n, 1);
    await assert.rejects(pool.query(`UPDATE works SET is_health = true WHERE id = (SELECT min(id) FROM works WHERE NOT is_health)`), /works_is_health_uidx/);
});

test("realtime_b: sinal já abortado ou abortado durante o banco → nem envio nem socket; contabilidade não confirmada → fail", async () => {
    // Revisão do #399: o relatório voltava por prazo e o corpo abandonado
    // ainda criava o envio e abria o Realtime depois.
    const { EventEmitter } = await import("node:events");
    let criou = 0, abriu = 0;
    class WS extends EventEmitter { constructor() { super(); abriu++; setTimeout(() => { this.emit("open"); for (let i = 0; i < 12; i++) this.emit("message", Buffer.alloc(4800, 1), true); }, 5); } close() { this.emit("close", 1000); } }
    const ops = (extra = {}) => ({
        limparSondasAntigas: async () => 0,
        criarSonda: async () => { criou++; return { id: 5, submission_token: "s" }; },
        custoDaSonda: async () => ({ cost_usd: 0.01, events: 1 }),
        registrarEstimativa: async () => {},
        ...extra,
    });
    const orcamento = { work_id: 7, exceeded: false, month_spent_usd: 0, monthly_budget_usd: 1 };
    // 1) sinal JÁ abortado quando o check começa
    const ja = new AbortController(); ja.abort();
    await assert.rejects(check("realtime_b").run({ deps: { WebSocket: WS, ops: ops(), settleMs: 5 }, orcamento, signal: ja.signal }), /prazo do check estourado antes de/);
    assert.equal(criou + abriu, 0);
    // 2) aborta ENQUANTO a limpeza no banco está presa: depois de liberada, não cria nem abre
    const ac = new AbortController();
    let liberar; const presa = new Promise(r => { liberar = r; });
    const lenta = ops({ limparSondasAntigas: async () => { await presa; return 0; } });
    const corrida = check("realtime_b").run({ deps: { WebSocket: WS, ops: lenta, settleMs: 5 }, orcamento, signal: ac.signal });
    setTimeout(() => { ac.abort(); liberar(); }, 30);
    await assert.rejects(corrida, /antes de criar o envio/);
    assert.equal(criou + abriu, 0, "corpo abandonado não pode gerar custo depois do relatório");
    // 3) o executor com prazo vem do runHealth (ctx.escritaComPrazo); a
    //    regressão com banco real está no teste seguinte
    const txt = fonte("lib/healthE2e.js");
    assert.match(txt, /OPS_TIMEOUT_MS = 5000/);
    assert.match(txt, /ctx\.escritaComPrazo/);
    assert.ok(!/recordRealtimeCost\(/.test(txt), "a estimativa vai pelo executor com prazo, não pelo pool do app (recordCost não tem prazo)");
    // 4) contabilidade: leitura falha / estimativa não persiste → fail mesmo com fala
    for (const [nome, extra, re] of [
        ["leitura falha", { custoDaSonda: async () => { throw new Error("banco fora (teste)"); } }, /banco fora/],
        ["estimativa não persiste", { custoDaSonda: async () => ({ cost_usd: 0, events: 0 }) }, /não ficou persistida/],
    ]) {
        const r = await check("realtime_b").run({ deps: { WebSocket: WS, ops: ops(extra), settleMs: 5 }, orcamento });
        assert.equal(r.status, "fail", nome);
        assert.match(r.detail.reason, /gasto não ficou confirmado/);
        assert.match(r.detail.accounting_error, re);
    }
});

test("sonda e2e com o banco preso: desiste no prazo, NADA fica na fila do pool, e nada acontece tarde no banco", semBanco, async () => {
    // Revisão do #399 (2ª rodada): Promise.race só larga a espera — a consulta
    // continuava na fila e rodava depois. Aqui as operações REAIS da sonda vão
    // por comClienteRW no pool do health, cuja única conexão está PRESA.
    const { comClienteRW } = health;
    const wid = (await pool.query(`SELECT id FROM works WHERE is_health`)).rows[0]?.id;
    assert.ok(wid, "seed do trabalho de saúde");
    const antes = (await pool.query(`SELECT count(*)::int n FROM submissions WHERE work_id = $1 AND is_test`, [wid])).rows[0].n;
    const preso = await healthPool.connect();
    try {
        const { EventEmitter } = await import("node:events");
        class WS extends EventEmitter { constructor() { super(); WS.abriu = (WS.abriu || 0) + 1; } close() {} }
        const t0 = Date.now();
        await assert.rejects(
            check("realtime_b").run({ deps: { WebSocket: WS, settleMs: 5 }, escritaComPrazo: (fn, ms) => comClienteRW(fn, ms), orcamento: { work_id: wid, exceeded: false, month_spent_usd: 0, monthly_budget_usd: 1 } }),
            /conexão com o banco|timeout exceeded when trying to connect/);
        assert.ok(Date.now() - t0 < 4500, "desiste no prazo de aquisição");
        assert.equal(healthPool.waitingCount, 0, "pedido de conexão não pode ficar na fila");
        assert.ok(!WS.abriu, "sem banco, não abre o relay");
    } finally { preso.release(); }
    await new Promise(r => setTimeout(r, 500));
    const depois = (await pool.query(`SELECT count(*)::int n FROM submissions WHERE work_id = $1 AND is_test`, [wid])).rows[0].n;
    assert.equal(depois, antes, "nenhuma operação tardia criou envio depois de a conexão voltar");
});

test("comClienteRW: escreve numa transação com prazo do servidor e devolve o cliente; prazo estourado descarta", semBanco, async () => {
    const { comClienteRW } = health;
    const r = await comClienteRW(async (q) => (await q("SELECT current_setting('statement_timeout') AS st, now() AS t")).rows[0]);
    assert.notEqual(r.st, "0", "statement_timeout tem de estar ligado na transação");
    assert.equal(healthPool.waitingCount, 0);
    await assert.rejects(comClienteRW(async (q) => q("SELECT pg_sleep(3)"), 1500), /prazo|timeout|cancel/i);
    const ok = await comClienteRW(async (q) => (await q("SELECT 1 AS um")).rows[0].um);
    assert.equal(ok, 1, "o pool se recupera depois do descarte");
});

test("trabalho de saúde não pode ser desativado: 409 na API, SQL protege, painel sem o botão", async () => {
    const adminRouter = (await import("../routes/admin.js")).default;
    const layer = adminRouter.stack.find(l => l.route?.path === "/admin/works/:workToken/active" && l.route.methods.patch);
    const handler = layer.route.stack.at(-1).handle;
    const original = pool.query;
    try {
        let updates = 0;
        pool.query = async (sql) => { if (/UPDATE works/.test(sql)) updates++; return { rows: [{ id: 1, is_health: true, is_active: true }], rowCount: 1 }; };
        const res = { status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } };
        await handler({ params: { workToken: "saude" }, body: { is_active: false }, session: { user: { username: "t" } } }, res);
        assert.equal(res.code, 409);
        assert.match(res.body.error, /permanente/);
        assert.equal(updates, 0, "nada de UPDATE");
    } finally { pool.query = original; }
    assert.match(fonte("lib/db/works.js"), /SET is_active = \$1, updated_at = now\(\)\s+WHERE id = \$2 AND NOT is_health/);
    const html = fonte("static/admin.html");
    assert.match(html, /const toggleBtn = w\.is_health \? ''/);
});

test("invariantes do e2e: nunca envia áudio de aluno, fecha o socket sempre, limpa só sondas ANTIGAS, e não roda no deep", () => {
    const txt = fonte("lib/healthE2e.js");
    assert.ok(!/ws\.send\(/.test(txt), "a sonda só escuta — nenhum áudio de aluno");
    assert.match(txt, /finally \{[\s\S]*ws\.close\(1000/);
    assert.match(txt, /created_at < now\(\) - interval '2 minutes'/, "a sonda atual nunca é apagada na própria execução");
    assert.match(txt, /is_test = true/);
    assert.match(txt, /orcamentoPermite\(ctx\)/, "paga: passa pelo orçamento mensal");
    assert.match(txt, /INSERT INTO work_cost_events/, "gasto do Realtime cortado antes do response.done é ESTIMADO e lançado — nunca fica fora do ledger");
    assert.match(txt, /UPDATE works SET spent_usd = spent_usd \+ \$1/, "a estimativa também soma no spent_usd do trabalho, como o recordCost faria");
});

test("retranscrição local: com motor api é skip (não se aplica), nunca ok", async () => {
    const r = await check("retranscribe_local").run({});
    const { RETRANSCRIBE_ENGINE } = await import("../lib/config.js");
    if (RETRANSCRIBE_ENGINE !== "local") { assert.equal(r.status, "skip"); assert.match(r.detail.reason, /retranscribe_engine/); }
    else assert.ok(["ok", "fail"].includes(r.status));
});

// O deep de verdade gasta dinheiro (~US$ 0,002) e exige chave da OpenAI: só
// roda quando pedido — HEALTH_DEEP_TESTS=1. É o que se roda antes de um PR.
const semDeep = process.env.HEALTH_DEEP_TESTS === "1" ? false : { skip: "HEALTH_DEEP_TESTS=1 para rodar o deep de verdade (gasta ~US$ 0,002)" };
test("deep de verdade: modelo, STT com texto conferido, TTS, ONNX, ffmpeg e Realtime perna A", semDeep, async () => {
    const { initAudioStore } = await import("../lib/audioStore.js");
    await initAudioStore();
    const r = await runHealth({ depth: "deep" });
    assert.equal(r.depth, "deep");
    assert.equal(r.checks.length, CHECK_IDS.length);
    const por = Object.fromEntries(r.checks.map(c => [c.id, c]));
    for (const id of ["storage", "responses", "stt", "tts", "vision", "ffmpeg", "realtime_a"]) {
        assert.ok(["ok", "warn"].includes(por[id].status), `${id}: ${por[id].status} ${JSON.stringify(por[id].detail)}`);
    }
    assert.ok(por.stt.detail.wer <= 0.2, `wer ${por.stt.detail.wer}`);
    assert.ok(por.realtime_a.detail.voices.every(v => v.ok), JSON.stringify(por.realtime_a.detail.voices));
    assert.ok(r.cost_usd > 0 && r.cost_usd < 0.05, `custo US$ ${r.cost_usd}`);
    assert.ok(por.responses.cost_usd > 0 && por.tts.cost_usd > 0 && por.stt.cost_usd > 0);
    // Contabilidade: cada check pago deixou linha no ledger do trabalho de saúde.
    assert.ok(["ok", "warn"].includes(por.budget.status), JSON.stringify(por.budget.detail));
    const wid = por.budget.detail.work_id;
    assert.ok(wid, "há trabalho de saúde");
    assert.equal(por.responses.detail.billed_to_work, wid);
    const ev = (await pool.query(`SELECT event_type, count(*)::int n FROM work_cost_events WHERE work_id = $1 AND created_at > now() - interval '2 minutes' GROUP BY 1`, [wid])).rows;
    const tipos = new Set(ev.map(e => e.event_type));
    for (const t of ["responses", "stt", "tts"]) assert.ok(tipos.has(t), `faltou ${t} no ledger: ${JSON.stringify(ev)}`);
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

test("migration 082 atualiza um banco que JÁ tem tokens (fluxo de dev: migration antes do servidor)", semBanco, async () => {
    // Revisão do #392: uma versão da 082 criava a FK dentro da migration, com
    // a tabela de alcances vazia — em banco com qualquer token, 23503. Aqui a
    // 082 real roda numa transação com tabelas TEMPORÁRIAS de mesmo nome (que
    // sombreiam as públicas no search_path) e um token pré-existente; rollback
    // no fim. Nada do banco real é tocado.
    const sql = fs.readFileSync(path.join(raiz, "migrations/082_analytics_token_scope.sql"), "utf8")
        .replace(/CREATE TABLE analytics_token_scopes/, "CREATE TEMP TABLE analytics_token_scopes");
    assert.ok(!/ADD CONSTRAINT|FOREIGN KEY|REFERENCES/i.test(sql.replace(/--[^\n]*/g, "")), "a FK não pode estar na 082 — vai na migration seguinte, num Publish posterior (ver o cabeçalho da 082)");
    const c = await pool.connect();
    try {
        await c.query("BEGIN");
        await c.query(`CREATE TEMP TABLE analytics_tokens (id BIGSERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, label TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ)`);
        await c.query(`INSERT INTO analytics_tokens (token_hash, token_prefix, expires_at) VALUES ('h081', 'oratia_analytics_x', now() + interval '1 day')`);
        for (const stmt of sql.replace(/--[^\n]*/g, "").split(";").map(x => x.trim()).filter(Boolean)) await c.query(stmt);
        const t = await c.query(`SELECT scope FROM analytics_tokens`);
        assert.deepEqual(t.rows.map(r => r.scope), ["analytics"], "token anterior à 082 nasce com alcance de análise");
        const sc = await c.query(`SELECT key, ttl_days FROM analytics_token_scopes ORDER BY key`);
        assert.deepEqual(sc.rows.map(r => [r.key, r.ttl_days]), [["analytics", 30], ["health", 365]]);
    } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
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
    const shallowIds = CHECKS.filter(c => c.level === "shallow").map(c => c.id);
    assert.equal(r.checks.length, shallowIds.length, "sem filtro, rodam todos os de shallow — e só eles");
    assert.deepEqual(r.checks.map(c => c.id), shallowIds, "ordem do registro");
    assert.equal(r.cost_usd, 0, "shallow custa zero, e diz isso");
    assert.ok(r.checks.every(c => c.level === "shallow"));
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

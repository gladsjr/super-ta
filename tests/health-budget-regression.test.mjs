// Regressões do PR #396. Provedores simulados; não gasta nem altera dados reais.
// node --test -r dotenv/config tests/health-budget-regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CHECKS, healthPool, runHealth } from '../lib/health.js';
import { pool } from '../auth.js';
import { openai } from '../lib/openaiClient.js';
import { deleteWork } from '../lib/db/works.js';
import adminRouter from '../routes/admin.js';

const check = id => CHECKS.find(c => c.id === id);

test('sem orçamento ou trabalho: os três checks pagos não chamam provedores', async t => {
    const bloquear = () => { throw new Error('provedor não deveria ser chamado'); };
    const responses = t.mock.method(openai.responses, 'create', bloquear);
    const tts = t.mock.method(openai.audio.speech, 'create', bloquear);
    const stt = t.mock.method(openai.audio.transcriptions, 'create', bloquear);
    for (const orcamento of [null, { work_id: null, exceeded: false }]) {
        for (const id of ['responses', 'stt', 'tts']) {
            const r = await check(id).run({ orcamento });
            assert.equal(r.status, 'skip', id);
            assert.equal(r.cost_usd, 0);
            assert.match(r.detail.reason, /bloqueada/);
        }
    }
    for (const m of [responses, tts, stt]) assert.equal(m.mock.callCount(), 0);
});

for (const scenario of [
    { name: 'cruza 80%', before: .79, after: .81, status: 'warn' },
    { name: 'cruza 100%', before: .99, after: 1.01, status: 'fail' },
    { name: 'falha na leitura final', before: .1, after: .12, finalError: true, status: 'fail' },
    { name: 'falha na leitura inicial', initialError: true, status: 'fail', blocked: true },
    { name: 'trabalho ausente', missing: true, status: 'fail', blocked: true },
    { name: 'orçamento esgotado', before: 1.1, status: 'fail', blocked: true },
]) {
    test(`seleção paga inclui budget: ${scenario.name}`, async t => {
        let reads = 0, calls = 0;
        t.mock.method(healthPool, 'connect', async () => ({
            release() {},
            async query(sql) {
                if (sql.includes('pg_backend_pid')) return { rows: [{ pid: 123 }] };
                if (sql.includes('FROM works')) {
                    reads++;
                    if (scenario.initialError || (scenario.finalError && reads === 2)) throw new Error('banco indisponível (teste)');
                    return { rows: scenario.missing ? [] : [{ id: 42 }] };
                }
                if (sql.includes('SUM(cost_usd)')) return { rows: [{ spent: reads === 1 ? scenario.before : scenario.after }] };
                return { rows: [] };
            },
        }));
        if (!scenario.blocked) t.mock.method(check('responses'), 'run', async ({ orcamento }) => {
            assert.equal(orcamento.work_id, 42);
            calls++;
            return { status: 'ok', cost_usd: .02 };
        });
        const provider = t.mock.method(openai.responses, 'create', () => { throw new Error('chamada indevida'); });
        const r = await runHealth({ depth: 'deep', ids: ['responses'] });
        assert.deepEqual(r.checks.map(c => c.id), ['budget', 'responses']);
        assert.equal(r.status, scenario.status);
        assert.equal(r.ok, scenario.status !== 'fail');
        assert.equal(r.checks[1].status, scenario.blocked ? 'skip' : 'ok');
        assert.equal(calls, scenario.blocked ? 0 : 1);
        assert.equal(provider.mock.callCount(), 0);
        assert.equal(reads, scenario.blocked ? 1 : 2);
        if (!scenario.blocked && !scenario.finalError) assert.equal(r.checks[0].detail.month_spent_usd, scenario.after);
        if (scenario.finalError) assert.ok(!('month_spent_usd' in r.checks[0].detail));
    });
}

test('seleção gratuita não depende do orçamento', async t => {
    const connect = t.mock.method(healthPool, 'connect', () => { throw new Error('não deve ler banco'); });
    const r = await runHealth({ depth: 'deep', ids: ['config'] });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.checks.map(c => c.id), ['config']);
    assert.equal(connect.mock.callCount(), 0);
});

test('API administrativa recusa exclusão de saúde antes de liberar cotas ou abrir transação', async t => {
    t.mock.method(pool, 'query', async sql => {
        assert.match(sql, /is_health/);
        return { rows: [{ id: 42, is_health: true }] };
    });
    const connect = t.mock.method(pool, 'connect', () => { throw new Error('não deve abrir transação'); });
    const layer = adminRouter.stack.find(l => l.route?.path === '/admin/works/:workToken' && l.route.methods.delete);
    const handler = layer.route.stack.at(-1).handle;
    const res = { status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { workToken: 'health-test' } }, res);
    assert.equal(res.code, 409);
    assert.match(res.body.error, /permanente/);
    assert.equal(connect.mock.callCount(), 0);
});

test('painel mostra trabalho permanente sem Excluir e preserva exclusão dos comuns', () => {
    const html = fs.readFileSync(new URL('../static/admin.html', import.meta.url), 'utf8');
    const source = html.slice(html.indexOf('function renderWorks()'), html.indexOf('async function toggleActive('));
    const elements = {
        'works-filter': { value: 'all' }, 'works-sort': { value: 'date' },
        works: { innerHTML: '' }, 'works-filtered-empty': { classList: { add() {} } },
    };
    vm.runInNewContext(source + '\nrenderWorks();', {
        document: { getElementById: id => elements[id] },
        escapeHtml: String,
        lastWorks: [
            { work_token: 'health', name: 'Saúde', is_health: true, is_active: false },
            { work_token: 'normal', name: 'Comum', is_health: false },
        ],
    });
    assert.match(elements.works.innerHTML, /Trabalho permanente/);
    assert.doesNotMatch(elements.works.innerHTML, /onclick="deleteWork\('health'\)/);
    assert.match(elements.works.innerHTML, /onclick="deleteWork\('normal'\)/);
});

test('SQL protege trabalho de saúde e mantém exclusão de trabalhos comuns', async t => {
    // Tabelas temporárias ocultam as reais somente nesta conexão, e somem no rollback.
    const pg = (await import('pg')).default;
    const local = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2500 });
    let client;
    try { client = await local.connect(); }
    catch (err) {
        await local.end();
        if (['ECONNREFUSED', 'ENOTFOUND'].includes(err.code)) {
            t.skip('Postgres indisponível — suba o banco para testar a exclusão e o CASCADE');
            return;
        }
        throw err;
    }
    try {
        await client.query('BEGIN');
        await client.query('CREATE TEMP TABLE works (id integer PRIMARY KEY, is_health boolean NOT NULL) ON COMMIT DROP');
        await client.query('CREATE TEMP TABLE work_cost_events (work_id integer REFERENCES works(id) ON DELETE CASCADE, cost_usd numeric) ON COMMIT DROP');
        await client.query('INSERT INTO works VALUES (1, true), (2, false)');
        await client.query('INSERT INTO work_cost_events VALUES (1, 0.9), (2, 0.2)');
        assert.equal(await deleteWork(1, client), false);
        assert.equal(await deleteWork(2, client), true);
        assert.deepEqual((await client.query('SELECT * FROM works')).rows, [{ id: 1, is_health: true }]);
        assert.deepEqual((await client.query('SELECT work_id FROM work_cost_events')).rows, [{ work_id: 1 }]);
    } finally {
        await client.query('ROLLBACK');
        client.release();
        await local.end();
    }
});

test.after(async () => { await healthPool.end(); await pool.end(); });

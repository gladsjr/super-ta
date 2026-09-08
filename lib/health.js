// Verificação de saúde (#375): registro de checks + execução seletiva.
//
// O que existe hoje sem isto: nada. Depois de um Publish, a forma de descobrir
// que algo não subiu é o aluno tropeçar nele. Este módulo dá à operação um
// jeito de perguntar ao sistema "o que está de pé?" antes disso — pela tela de
// Operações e por um endpoint que uma ferramenta de monitoração chama sozinha.
//
// Três profundidades, por CUSTO e por EFEITO COLATERAL:
//   - shallow  → sem custo e sem efeito: lê config, banco, schema, seeds,
//                filas, binários e assets. É o que roda de minuto em minuto.
//   - deep     → uma ida real a cada dependência externa (storage, Responses,
//                STT, TTS, proctoring nativo, Realtime perna A). Poucos
//                centavos. Roda depois do Publish. (corte seguinte)
//   - e2e      → relay completo em produção, sob pedido explícito. (corte
//                seguinte)
// Este arquivo implementa o nível `shallow`; os outros dois estão declarados
// para o contrato do endpoint já nascer completo, e são recusados com 501.
//
// Quatro estados por check, não dois: "responde, mas em 4 s" é aviso, não
// falha; e "não se aplica a este ambiente" é `skip`, não `ok` — dizer `ok` sobre
// o que não foi medido é o erro que o painel da prova oral cometia (#360). Pela
// mesma razão, um check que não conseguiu medir (tabela que deveria existir e
// não existe, banco fora) é `fail` com o motivo, nunca `ok` com um campo nulo.
//
// Regras duras:
//   - NENHUM check de `shallow` escreve, gasta ou chama provedor externo. Os
//     checks de banco rodam numa transação READ ONLY — o backstop é o Postgres.
//   - NENHUM check pode pendurar, e estourar o prazo NÃO pode deixar consulta
//     pendurada no pool: os checks de banco compartilham UM cliente, obtido com
//     prazo (se chegar tarde, é devolvido na hora), e cada transação leva um
//     statement_timeout — quem cancela a consulta é o servidor, não o relógio
//     daqui. O relógio daqui é só a última linha de defesa.
//   - NADA aqui bloqueia o event loop: o relay de voz está no mesmo processo.
//     Um spawnSync de 1 s a cada minuto é 1 s de áudio congelado a cada minuto.
//   - O boot NÃO roda DDL (ADR 0001): o check de schema é leitura pura.
//   - O check de schema NÃO usa o ledger `schema_migrations` como verdade: em
//     produção o Publish materializa o schema sem escrever nele (medido em
//     07/09/2026: 8 linhas no ledger, 80 migrations no banco). O que se
//     confere é o CATÁLOGO — ver lib/schemaExpectations.js.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { pool } from "../auth.js";
import { listMigrationStatusReadOnly } from "./migrations.js";
import { expectedSchema, afterBaseline, readMigrationFiles, diffExpected, readCatalog } from "./schemaExpectations.js";
import { heartbeat } from "./jobsHeartbeat.js";
import { TOKEN_SCOPE_DEFS } from "./db/analyticsTokens.js";
import { CONSENT_VERSION } from "../config/consent.js";
import { FALLBACK_VOICE } from "../config/voices.js";
import {
    PROJECT_ROOT,
    PRINCIPAL_REASONING_MODEL, PRINCIPAL_REASONING_EFFORT, FAST_MODEL,
    STT_PROVIDER, STT_MODEL, STT_FALLBACK_PROVIDER,
    TTS_MODEL, REALTIME_MODEL, RETRANSCRIBE_ENGINE, JOBS_POLL_SECONDS,
} from "./config.js";
import log from "./logger.js";

export const DEPTHS = ["shallow", "deep", "e2e"];
export const STATUSES = ["ok", "warn", "fail", "skip"];

// Prazo por check no nível shallow. Generoso para um SELECT, curto o bastante
// para a monitoração de minuto em minuto não empilhar chamadas.
export const SHALLOW_TIMEOUT_MS = 3000;
// O servidor cancela a consulta ANTES do relógio daqui estourar.
const STATEMENT_TIMEOUT_MS = 2500;

// Latência de banco acima disto é aviso: o servidor segue de pé, mas algo está
// errado entre o app e o Postgres (pool esgotado, rede, banco sob carga).
const DB_WARN_MS = 500;

// Fila: sem tique do executor por mais que isto (em intervalos de poll) é
// executor parado; job pendente há mais que isto é fila parada. Com o motor
// local a retranscrição espera a janela ociosa — por isso é aviso, não falha.
const RUNNER_SILENT_POLLS = 3;
const JOBS_STALE_MINUTES = 60;

// ----------------------------------------------------------------------------
// Commit em execução. Depois de um Publish, "qual código está rodando?" é a
// primeira pergunta — e não há mecanismo para isso hoje. Tenta o git (workspace
// do Replit e dev local têm .git); em deployment sem .git cai na variável de
// ambiente; sem nada, diz que não sabe, em vez de inventar. Roda UMA vez, no
// boot — é o único síncrono deste arquivo, e nunca no caminho de uma chamada.
function detectCommit() {
    if (process.env.GIT_COMMIT) return String(process.env.GIT_COMMIT).slice(0, 12);
    try {
        const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 2000 });
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch { /* sem git */ }
    // Deployment do Replit não leva o .git: o passo de build em `.replit`
    // grava o commit em .build-commit (medido em prod em 07/09: commit null).
    try {
        const c = fs.readFileSync(path.join(PROJECT_ROOT, ".build-commit"), "utf8").trim();
        if (c) return c.slice(0, 12);
    } catch { /* sem arquivo */ }
    return null;
}
export const COMMIT = detectCommit();

// O schema esperado, derivado dos arquivos de migration — uma vez, no boot.
// FULL é o replay completo (para teste e validação do parser); o check usa só
// o que veio DEPOIS da linha de base (ver lib/schemaExpectations.js).
export const EXPECTED_SCHEMA_FULL = expectedSchema(readMigrationFiles(path.join(PROJECT_ROOT, "migrations")));
export const EXPECTED_SCHEMA = afterBaseline(EXPECTED_SCHEMA_FULL);

const { Pool } = pg;

// ----------------------------------------------------------------------------
// Utilitários

const resultado = (status, detail = {}) => ({ status, detail });

// Uma tabela que não existe é um RESULTADO do health check (o Publish não levou
// o schema), não uma exceção a esconder. Distingue-se do erro genérico.
const tabelaAusente = (err) => /relation .* does not exist/i.test(err?.message || "");

export async function comPrazo(promise, ms, rotulo = "prazo") {
    let timer;
    const prazo = new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error(`${rotulo} de ${ms} ms estourado`), { timeout: true })), ms);
    });
    try { return await Promise.race([promise, prazo]); }
    finally { clearTimeout(timer); }
}

function arquivoOk(rel) {
    const full = path.join(PROJECT_ROOT, rel);
    try {
        const st = fs.statSync(full);
        return { path: rel, ok: st.isFile() && st.size > 0, bytes: st.size };
    } catch {
        return { path: rel, ok: false, bytes: 0 };
    }
}

// Roda `fn(q)` numa transação SOMENTE-LEITURA com statement_timeout local. O
// READ ONLY é o backstop de "shallow não escreve"; o timeout faz o SERVIDOR
// cancelar a consulta lenta, em vez de deixá-la correndo depois que o relógio
// daqui desistiu. Erro → ROLLBACK e propaga (vira `fail` com motivo).
async function emTransacaoRO(client, fn) {
    await client.query("START TRANSACTION READ ONLY");
    try {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const out = await fn((sql, values) => client.query(sql, values));
        await client.query("COMMIT");
        return out;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    }
}

// Pool PRÓPRIO do health check, de uma conexão, com prazo de conexão. Dois
// motivos para não usar o pool do app: (1) o pool do app não tem prazo — um
// pedido de conexão fica na fila até o banco voltar, e a monitoração de minuto
// em minuto empilharia pedidos durante uma queda; aqui o prazo CANCELA o
// pedido (o pg-pool o tira da fila); (2) com o pool do app saturado por alunos
// o check ficaria na fila atrás deles — e o que se quer medir nesse caso é
// justamente "o pool do app está saturado", que sai como aviso a partir dos
// contadores do pool do app, sem o check depender dele para responder.
export const healthPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    keepAlive: true,
    max: 1,
    connectionTimeoutMillis: SHALLOW_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
});
// Cliente ocioso pode emitir 'error' quando a conexão cai — sem listener isso
// derruba o processo (ver auth.js).
healthPool.on("error", (err) => log.warn("HEALTH", `pool: ${err.message}`));

async function adquirirCliente(ms) {
    const t0 = Date.now();
    const client = await comPrazo(healthPool.connect(), ms, "conexão com o banco");
    client.acquireMs = Date.now() - t0; // só a conexão; a ida do pid não conta como latência
    // O pid do backend serve para cancelar a consulta se o prazo TOTAL de um
    // check estourar com a transação ainda rodando (ver descartarCliente).
    try { client.backendPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; }
    catch { client.backendPid = null; }
    return client;
}

// Prazo total estourado com a transação ainda em curso: a conexão NÃO volta ao
// pool (voltaria ocupada, e o check seguinte herdaria a fila dela). Ela é
// destruída, e o backend do Postgres recebe um cancel pela conexão nova —
// senão a consulta órfã segue rodando no servidor até tentar responder a um
// socket fechado. Caso real da revisão do #388: três SELECTs de 1,2 s cabem
// cada um no statement_timeout e somados passam do prazo do check.
async function descartarCliente(client) {
    const pid = client.backendPid;
    try { client.release(true); } catch { /* já fora do pool */ }
    if (!pid) return;
    try {
        const c = await comPrazo(healthPool.connect(), 1000, "conexão para cancelar");
        try { await c.query("SELECT pg_cancel_backend($1)", [pid]); }
        finally { c.release(); }
    } catch (err) {
        log.warn("HEALTH", `não deu para cancelar o backend ${pid}: ${err.message}`);
    }
}

// Um cliente do pool do health, numa transação somente-leitura com
// statement_timeout, para quem precisa de UMA leitura fora do relatório (a
// validação do token no endpoint). Prazo estourado destrói o cliente.
export async function comClienteRO(fn, ms = SHALLOW_TIMEOUT_MS) {
    const client = await adquirirCliente(ms);
    let descartado = false;
    try {
        return await comPrazo(emTransacaoRO(client, fn), ms, "leitura");
    } catch (err) {
        if (err.timeout) { descartado = true; await descartarCliente(client); }
        throw err;
    } finally {
        if (!descartado) client.release();
    }
}

// ----------------------------------------------------------------------------
// Os checks de nível shallow. Os de banco recebem `ctx.q` (executor dentro da
// transação RO) e nunca tocam no pool diretamente.

async function checkConfig() {
    // Nada a "validar" aqui — policy.yaml e pricing.yaml já derrubam o boot se
    // estiverem errados (ADR 0002). O que falta é VER qual config produção está
    // de fato rodando, porque o Publish pode ter levado outro policy.yaml.
    return resultado("ok", {
        principal_reasoning_model: PRINCIPAL_REASONING_MODEL,
        principal_reasoning_effort: PRINCIPAL_REASONING_EFFORT,
        fast_model: FAST_MODEL,
        stt_provider: STT_PROVIDER,
        stt_fallback_provider: STT_FALLBACK_PROVIDER,
        stt_model: STT_MODEL,
        tts_model: TTS_MODEL,
        realtime_model: REALTIME_MODEL,
        retranscribe_engine: RETRANSCRIBE_ENGINE,
        jobs_poll_seconds: JOBS_POLL_SECONDS,
        default_voice: FALLBACK_VOICE,
        node: process.version,
        env: process.env.NODE_ENV || null,
    });
}

async function checkDb(ctx) {
    const t0 = Date.now();
    await ctx.q("SELECT 1");
    const query_ms = Date.now() - t0;
    const latency_ms = ctx.acquire_ms + query_ms;
    // O pool do APP é o que os alunos sentem: alguém esperando conexão ali é
    // saturação, mesmo com o banco respondendo rápido a este check.
    const app = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    const avisos = [];
    if (latency_ms > DB_WARN_MS) avisos.push(`latência ${latency_ms} ms (limite ${DB_WARN_MS})`);
    if (app.waiting > 0) avisos.push(`${app.waiting} pedido(s) esperando conexão no pool do app`);
    return resultado(avisos.length ? "warn" : "ok", {
        latency_ms, acquire_ms: ctx.acquire_ms, query_ms, pool: app, warnings: avisos,
    });
}

async function checkSchema(ctx) {
    // O check mais valioso pós-Publish: o diff dev→prod pode não levar um
    // objeto (já deixou constraint para trás duas vezes), e o sintoma aparece
    // dias depois numa rota que faz SELECT numa coluna que não existe.
    // Confere no CATÁLOGO que o que as migrations POSTERIORES à linha de base
    // criam existe — com a migration de origem de cada ausência.
    const catalog = await readCatalog(ctx.q);
    // Cada ausência leva junto o que o catálogo TEM naquela tabela, do mesmo
    // tipo: é o que diz se o objeto falta mesmo ou existe com outro nome
    // (caso da #389: FK da 074 acusada em prod sem dar para ver o catálogo).
    const missing = diffExpected(EXPECTED_SCHEMA, catalog).map(m => {
        const table = m.kind === "table" ? m.name
            : m.kind === "index" ? EXPECTED_SCHEMA.indexes.get(m.name)?.table
            : m.name.split(".")[0];
        let present = [];
        if (m.kind === "column") present = [...catalog.columns].filter(c => c.startsWith(table + ".")).map(c => c.slice(table.length + 1));
        else if (m.kind === "constraint") present = [...catalog.constraints].filter(c => c.startsWith(table + ".")).map(c => c.slice(table.length + 1));
        else if (m.kind === "index") present = [...catalog.indexes].filter(i => catalog.indexTables?.get(i) === table);
        return { ...m, table, present_on_table: present.sort() };
    });
    // O ledger entra só como informação: em dev ele é a verdade (pendente =
    // alguém esqueceu o db:migrate); em prod ele fica para trás por desenho.
    const ledger = await listMigrationStatusReadOnly(ctx.q);
    const aplicadas = ledger.migrations.filter(m => m.applied);
    const arquivos = ledger.migrations;
    return resultado(missing.length ? "fail" : "ok", {
        baseline: EXPECTED_SCHEMA.baseline,
        expected: {
            tables: EXPECTED_SCHEMA.tables.size, columns: EXPECTED_SCHEMA.columns.size,
            indexes: EXPECTED_SCHEMA.indexes.size, constraints: EXPECTED_SCHEMA.constraints.size,
        },
        missing,
        files: arquivos.length,
        latest: arquivos.length ? arquivos[arquivos.length - 1].filename : null,
        ledger: {
            table_present: !ledger.tableMissing,
            applied: aplicadas.length,
            latest: aplicadas.length ? aplicadas[aplicadas.length - 1].filename : null,
            note: "informativo — em produção o Publish materializa o schema sem escrever aqui (ADR 0001)",
        },
    });
}

async function checkSeeds(ctx) {
    // Pega "o Publish levou o schema mas não os dados de bootstrap": as tabelas
    // de enumeração (ADR 0011) existem, mas estão vazias, e o app falha em
    // lugares que ninguém relaciona com isso.
    const tabelas = ["roles", "auth_providers", "unit_labels", "civil_id_types", "proctor_review_levels", "analytics_token_scopes"];
    const counts = {};
    const vazias = [];
    const ausentes = [];
    for (const t of tabelas) {
        try {
            const r = await ctx.q(`SELECT count(*)::int AS n FROM ${t}`);
            const n = Number(r.rows[0]?.n ?? 0);
            counts[t] = n;
            if (n === 0) vazias.push(t);
        } catch (err) {
            if (!tabelaAusente(err)) throw err;
            counts[t] = null; ausentes.push(t);
        }
    }
    // O mesmo critério de auth.js#seedBootstrapAdmin: existe ao menos um
    // admin_global sem unidade. Sem isso o painel institucional não tem dono.
    // Tabela ausente aqui é ausência a acusar, não "não sei" a deixar passar.
    let adminBootstrap = null;
    try {
        const r = await ctx.q(
            `SELECT count(*)::int AS n FROM memberships m JOIN roles r ON r.id = m.role_id
              WHERE r.key = 'admin_global' AND m.unit_id IS NULL`
        );
        adminBootstrap = Number(r.rows[0]?.n ?? 0) > 0;
    } catch (err) {
        if (!tabelaAusente(err)) throw err;
        if (!ausentes.includes("roles")) ausentes.push("memberships");
    }
    // Alcances do token (#375): não basta a tabela ter linhas — as DUAS chaves
    // com validade positiva precisam estar lá, senão nenhum token é emitido e
    // a monitoração perde a porta de entrada. Preenchimento parcial é fail.
    let scopesFaltando = [];
    if (!ausentes.includes("analytics_token_scopes")) {
        const r = await ctx.q(`SELECT key, ttl_days FROM analytics_token_scopes`);
        const vistos = new Map(r.rows.map(x => [x.key, Number(x.ttl_days)]));
        scopesFaltando = TOKEN_SCOPE_DEFS.filter(d => !(vistos.get(d.key) > 0)).map(d => d.key);
    }
    const status = (ausentes.length || vazias.length || scopesFaltando.length || adminBootstrap !== true) ? "fail" : "ok";
    return resultado(status, { counts, empty: vazias, missing: ausentes, token_scopes_missing: scopesFaltando, admin_bootstrap: adminBootstrap });
}

async function checkJobs(ctx) {
    // Leitura pura da tabela `jobs` (ADR 0022) mais o batimento do executor.
    // Três sintomas de "a bomba parou", nenhum dos quais a profundidade da
    // fila sozinha revela: lease vencida (executor morreu no meio), executor
    // sem tique (setInterval morto, processo antigo), pendente envelhecendo
    // (ninguém tira da fila — a fila vazia também pode ser "nada entrou").
    let rows;
    try {
        rows = (await ctx.q(`
            SELECT type, status, count(*)::int AS n,
                   count(*) FILTER (WHERE status = 'running' AND lease_until < now())::int AS lease_vencida,
                   count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '24 hours')::int AS falhas_24h,
                   min(created_at) FILTER (WHERE status = 'pending') AS pendente_mais_antigo
              FROM jobs GROUP BY type, status ORDER BY type, status`)).rows;
    } catch (err) {
        if (tabelaAusente(err)) return resultado("fail", { reason: "tabela jobs não existe (migration 078)" });
        throw err;
    }
    const lanes = {};
    let leaseVencida = 0, falhas24h = 0, pendentes = 0, maisAntigo = null;
    for (const r of rows) {
        lanes[r.type] ??= {};
        lanes[r.type][r.status] = r.n;
        leaseVencida += Number(r.lease_vencida || 0);
        falhas24h += Number(r.falhas_24h || 0);
        if (r.status === "pending") pendentes += r.n;
        if (r.pendente_mais_antigo && (!maisAntigo || new Date(r.pendente_mais_antigo) < maisAntigo)) maisAntigo = new Date(r.pendente_mais_antigo);
    }
    const agora = Date.now();
    const pendenteMin = maisAntigo ? Math.round((agora - maisAntigo.getTime()) / 60000) : 0;
    const filaParada = pendentes > 0 && pendenteMin > JOBS_STALE_MINUTES;

    // Batimento: só faz sentido no processo que ligou o executor (server.js).
    // Antes do primeiro tique (setInterval não dispara na hora) conta a partir
    // do started_at. Sem executor ligado (testes, scripts) é `null`, não ok.
    let runner = null, executorParado = false;
    if (heartbeat.started_at) {
        const ultimo = heartbeat.last_tick_at || heartbeat.started_at;
        const silencioS = Math.round((agora - ultimo.getTime()) / 1000);
        executorParado = silencioS > RUNNER_SILENT_POLLS * JOBS_POLL_SECONDS;
        runner = { last_tick_at: heartbeat.last_tick_at, silent_s: silencioS, last_error: heartbeat.last_error };
    }

    const avisos = [];
    if (leaseVencida > 0) avisos.push(`${leaseVencida} job(s) com lease vencida`);
    if (falhas24h > 0) avisos.push(`${falhas24h} falha(s) nas últimas 24 h`);
    if (filaParada) avisos.push(`pendente há ${pendenteMin} min (limite ${JOBS_STALE_MINUTES})`);
    if (executorParado) avisos.push(`executor sem tique há ${runner.silent_s} s`);
    return resultado(avisos.length ? "warn" : "ok", {
        lanes, pending: pendentes, oldest_pending_min: pendenteMin, expired_leases: leaseVencida,
        failed_last_24h: falhas24h, poll_seconds: JOBS_POLL_SECONDS, engine: RETRANSCRIBE_ENGINE, runner, warnings: avisos,
    });
}

// Assíncrono e com prazo: o relay de voz vive neste processo, e um spawnSync
// de 1 s congela o áudio de todo mundo por 1 s. E uma vez achado, fica: o
// binário não muda enquanto o processo vive, então o spawn sai do caminho de
// minuto em minuto (no Windows até o spawn assíncrono custa centenas de ms).

async function checkAssets() {
    // Deploy que subiu sem asset: modelos ONNX/MediaPipe, WASM da visão, os mp3
    // do sound check. Nenhum deles é código, todos são obrigatórios, e o boot
    // não os confere. SÓ arquivos: lançar binário (ffmpeg) é coisa do nível
    // deep — em produção (07/09) `ffmpeg -version` não respondeu em 8 s, e um
    // check shallow não pode custar isso nem depender de processo filho.
    const arquivos = [
        "models/yolov8n.onnx",
        "models/yolov8n-pose.onnx",
        "models/hand_landmarker.task",
        "models/pose_landmarker.task",
        "static/vision/wasm/vision_wasm_internal.wasm",
        "static/vision/wasm/vision_wasm_internal.js",
        "static/vision/wasm/vision_wasm_nosimd_internal.wasm",
        "static/vision/wasm/vision_wasm_nosimd_internal.js",
    ].map(arquivoOk);
    let mp3 = 0;
    try { mp3 = fs.readdirSync(path.join(PROJECT_ROOT, "static/audio/soundcheck")).filter(f => f.endsWith(".mp3")).length; } catch { /* dir ausente */ }
    const faltando = arquivos.filter(a => !a.ok).map(a => a.path);
    const status = (faltando.length || mp3 < 10) ? "fail" : "ok";
    return resultado(status, { missing: faltando, soundcheck_mp3: mp3, soundcheck_expected: 10 });
}

async function checkConsent(ctx) {
    // Qual termo está ativo e quantos alunos aceitaram uma versão anterior.
    // Versão nova é outro termo (#346); saber quantos vão reaceitar evita
    // surpresa depois de publicar. Sem a tabela não há medição — é `fail`.
    let anteriores;
    try {
        const r = await ctx.q(
            `SELECT count(*)::int AS n FROM submissions WHERE consent_version IS NOT NULL AND consent_version <> $1`,
            [CONSENT_VERSION]
        );
        anteriores = Number(r.rows[0]?.n ?? 0);
    } catch (err) {
        if (!tabelaAusente(err)) throw err;
        return resultado("fail", { version: CONSENT_VERSION, reason: "tabela submissions não existe" });
    }
    return resultado("ok", { version: CONSENT_VERSION, submissions_on_older_version: anteriores });
}

// Registro. A ordem é a ordem de exibição na tela e no relatório. `db: true`
// marca quem roda dentro da transação somente-leitura, no cliente único.
// `budget_ms` opcional é o prazo externo do check quando o padrão
// (SHALLOW_TIMEOUT_MS) não couber.
export const CHECKS = [
    { id: "config",     label: "Configuração ativa",            level: "shallow", db: false, run: checkConfig },
    { id: "db",         label: "Banco de dados",                level: "shallow", db: true,  run: checkDb },
    { id: "migrations", label: "Schema materializado",          level: "shallow", db: true,  run: checkSchema },
    { id: "seeds",      label: "Seeds e admin de bootstrap",    level: "shallow", db: true,  run: checkSeeds },
    { id: "jobs",       label: "Filas (vídeo e retranscrição)", level: "shallow", db: true,  run: checkJobs },
    { id: "assets",     label: "Modelos e arquivos de mídia",   level: "shallow", db: false, run: checkAssets },
    { id: "consent",    label: "Termo de consentimento",        level: "shallow", db: true,  run: checkConsent },
];
export const CHECK_IDS = CHECKS.map(c => c.id);

// ----------------------------------------------------------------------------
// Execução

const PESO = { ok: 0, skip: 0, warn: 1, fail: 2 };

// O pior estado entre vários. `skip` não pesa: não medido não é ruim nem bom.
export function worstStatus(statuses) {
    let pior = "ok";
    for (const s of statuses) if ((PESO[s] ?? 2) > PESO[pior]) pior = s;
    return pior;
}

const montar = (check, status, t0, detail) =>
    ({ id: check.id, label: check.label, status, duration_ms: Date.now() - t0, detail, cost_usd: 0 });

async function executarUm(check, ctx) {
    const t0 = Date.now();
    if (check.db && !ctx.client) {
        // Sem cliente não há medição — e não medido não é ok.
        return montar(check, "fail", t0, { error: `não medido: ${ctx.erroBanco}` });
    }
    try {
        const corpo = check.db
            ? emTransacaoRO(ctx.client, (q) => check.run({ ...ctx, q }))
            : check.run(ctx);
        const r = await comPrazo(corpo, check.budget_ms ?? SHALLOW_TIMEOUT_MS, `check ${check.id}`);
        return montar(check, r.status, t0, r.detail ?? {});
    } catch (err) {
        log.warn("HEALTH", `check ${check.id} falhou: ${err.message}`);
        if (check.db && err.timeout) {
            // A transação ainda pode estar rodando neste cliente: descarta e
            // pega outro para o check seguinte. Se não conseguir outro, os
            // seguintes saem como "não medido" — nunca herdam a conexão presa.
            await descartarCliente(ctx.client);
            ctx.client = null;
            try { ctx.client = await adquirirCliente(SHALLOW_TIMEOUT_MS); }
            catch (e2) { ctx.erroBanco = `sem conexão após o prazo do check ${check.id}: ${e2.message}`; }
        }
        return montar(check, "fail", t0, { error: err.message });
    }
}

// Roda os checks pedidos (todos os do nível, por padrão). Os que não tocam no
// banco correm em paralelo; os de banco correm EM SÉRIE num único cliente —
// uma conexão por chamada, não cinco, e nenhuma fica para trás se algo
// pendurar. Devolve o corpo completo do contrato do endpoint; quem chama
// decide o status HTTP a partir de `status`.
export async function runHealth({ ids = null, depth = "shallow" } = {}) {
    if (!DEPTHS.includes(depth)) throw Object.assign(new Error(`depth inválido: ${depth}`), { httpStatus: 400 });
    if (depth !== "shallow") {
        throw Object.assign(new Error(`nível "${depth}" ainda não implementado neste corte — só "shallow"`), { httpStatus: 501 });
    }
    if (ids) {
        // Seleção vazia não é "nenhum check": é erro de configuração do robô,
        // e um relatório vazio com ok:true seria saúde declarada sem medir.
        if (!ids.length) throw Object.assign(new Error("checks= vazio — omita o parâmetro para rodar todos"), { httpStatus: 400 });
        const desconhecidos = ids.filter(i => !CHECK_IDS.includes(i));
        if (desconhecidos.length) throw Object.assign(new Error(`checks desconhecidos: ${desconhecidos.join(", ")}`), { httpStatus: 400 });
    }
    const escolhidos = CHECKS.filter(c => c.level === depth && (!ids || ids.includes(c.id)));
    const t0 = Date.now();

    const ctx = { client: null, erroBanco: null, acquire_ms: 0 };
    if (escolhidos.some(c => c.db)) {
        try { ctx.client = await adquirirCliente(SHALLOW_TIMEOUT_MS); ctx.acquire_ms = ctx.client.acquireMs; }
        catch (err) { ctx.erroBanco = err.message; }
    }
    try {
        const semBanco = Promise.all(escolhidos.filter(c => !c.db).map(c => executarUm(c, ctx)));
        const comBanco = (async () => {
            const out = [];
            for (const c of escolhidos.filter(c => c.db)) out.push(await executarUm(c, ctx));
            return out;
        })();
        const feitos = [...await semBanco, ...await comBanco];
        const checks = escolhidos.map(c => feitos.find(f => f.id === c.id));
        const status = worstStatus(checks.map(c => c.status));
        return {
            ok: status !== "fail",
            status,
            ts: new Date().toISOString(),
            commit: COMMIT,
            env: process.env.NODE_ENV || (process.env.REPL_ID ? "replit" : "local"),
            depth,
            duration_ms: Date.now() - t0,
            checks,
        };
    } finally {
        ctx.client?.release();
    }
}

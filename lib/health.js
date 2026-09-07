// Verificação de saúde (#375): registro de checks + execução seletiva.
//
// O que existe hoje sem isto: nada. Depois de um Publish, a forma de descobrir
// que algo não subiu é o aluno tropeçar nele. Este módulo dá à operação um
// jeito de perguntar ao sistema "o que está de pé?" antes disso — pela tela de
// Operações e por um endpoint que uma ferramenta de monitoração chama sozinha.
//
// Três profundidades, por CUSTO e por EFEITO COLATERAL:
//   - shallow  → sem custo e sem efeito: lê config, banco, migrations, seeds,
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
// o que não foi medido é o erro que o painel da prova oral cometia (#360).
//
// Regras duras:
//   - NENHUM check de `shallow` escreve, gasta ou chama provedor externo.
//   - NENHUM check pode pendurar: cada um roda com prazo próprio, e estourar o
//     prazo é `fail` com motivo, nunca espera infinita (o pool do pg espera
//     para sempre quando o servidor não existe — ver tests/video-legado-toca).
//   - O boot NÃO roda DDL (ADR 0001): o check de migrations é leitura pura.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pool } from "../auth.js";
import { listMigrationStatusReadOnly } from "./migrations.js";
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

// Prazo por check no nível shallow. Generoso para um SELECT 1, curto o bastante
// para a monitoração de minuto em minuto não empilhar chamadas.
const SHALLOW_TIMEOUT_MS = 3000;

// Latência de banco acima disto é aviso: o servidor segue de pé, mas algo está
// errado entre o app e o Postgres (pool esgotado, rede, banco sob carga).
const DB_WARN_MS = 500;

// ----------------------------------------------------------------------------
// Commit em execução. Depois de um Publish, "qual código está rodando?" é a
// primeira pergunta — e não há mecanismo para isso hoje. Tenta o git (workspace
// do Replit e dev local têm .git); em deployment sem .git cai na variável de
// ambiente; sem nada, diz que não sabe, em vez de inventar.
function detectCommit() {
    if (process.env.GIT_COMMIT) return String(process.env.GIT_COMMIT).slice(0, 12);
    try {
        const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 2000 });
        if (r.status === 0) return r.stdout.trim() || null;
    } catch { /* sem git */ }
    return null;
}
export const COMMIT = detectCommit();

// ----------------------------------------------------------------------------
// Utilitários dos checks

const resultado = (status, detail = {}) => ({ status, detail });

// Uma tabela que não existe é um RESULTADO do health check (o Publish não levou
// o schema), não uma exceção a esconder. Distingue-se do erro genérico.
const tabelaAusente = (err) => /relation .* does not exist/i.test(err?.message || "");

async function contar(sql) {
    const r = await pool.query(sql);
    return Number(r.rows[0]?.n ?? 0);
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

// ----------------------------------------------------------------------------
// Os checks de nível shallow

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

async function checkDb() {
    const t0 = Date.now();
    await pool.query("SELECT 1");
    const ms = Date.now() - t0;
    const detail = {
        latency_ms: ms,
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    };
    return resultado(ms > DB_WARN_MS ? "warn" : "ok", detail);
}

async function checkMigrations() {
    // O check mais valioso pós-Publish: o diff dev→prod pode não levar um
    // arquivo, e o sintoma aparece dias depois numa rota que faz SELECT numa
    // coluna que não existe.
    const { tableMissing, migrations } = await listMigrationStatusReadOnly();
    if (tableMissing) {
        return resultado("fail", { reason: "schema_migrations não existe — o banco nunca foi migrado", total: migrations.length, applied: 0 });
    }
    const pendentes = migrations.filter(m => !m.applied).map(m => m.filename);
    return resultado(pendentes.length ? "fail" : "ok", {
        total: migrations.length,
        applied: migrations.length - pendentes.length,
        pending: pendentes,
        latest: migrations.length ? migrations[migrations.length - 1].filename : null,
    });
}

async function checkSeeds() {
    // Pega "o Publish levou o schema mas não os dados de bootstrap": as tabelas
    // de enumeração (ADR 0011) existem, mas estão vazias, e o app falha em
    // lugares que ninguém relaciona com isso.
    const tabelas = ["roles", "auth_providers", "unit_labels", "civil_id_types", "proctor_review_levels"];
    const counts = {};
    const vazias = [];
    const ausentes = [];
    for (const t of tabelas) {
        try {
            const n = await contar(`SELECT count(*)::int AS n FROM ${t}`);
            counts[t] = n;
            if (n === 0) vazias.push(t);
        } catch (err) {
            if (tabelaAusente(err)) { counts[t] = null; ausentes.push(t); }
            else throw err;
        }
    }
    // O mesmo critério de auth.js#seedBootstrapAdmin: existe ao menos um
    // admin_global sem unidade. Sem isso o painel institucional não tem dono.
    let adminBootstrap = null;
    try {
        adminBootstrap = (await contar(
            `SELECT count(*)::int AS n FROM memberships m JOIN roles r ON r.id = m.role_id
              WHERE r.key = 'admin_global' AND m.unit_id IS NULL`
        )) > 0;
    } catch (err) {
        if (!tabelaAusente(err)) throw err;
    }
    const status = (ausentes.length || vazias.length || adminBootstrap === false) ? "fail" : "ok";
    return resultado(status, { counts, empty: vazias, missing: ausentes, admin_bootstrap: adminBootstrap });
}

async function checkJobs() {
    // Leitura pura da tabela `jobs` (ADR 0022): profundidade por lane, lease
    // vencida (executor morreu no meio) e falhas recentes. Um `running` com
    // lease no passado é o sinal de que a bomba parou; o próximo tique repesca,
    // mas se ninguém está tirando da fila, isso cresce em silêncio.
    let rows;
    try {
        rows = (await pool.query(`
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
    let leaseVencida = 0, falhas24h = 0, pendentes = 0;
    for (const r of rows) {
        lanes[r.type] ??= {};
        lanes[r.type][r.status] = r.n;
        leaseVencida += r.lease_vencida;
        falhas24h += r.falhas_24h;
        if (r.status === "pending") pendentes += r.n;
    }
    const status = (leaseVencida > 0 || falhas24h > 0) ? "warn" : "ok";
    return resultado(status, { lanes, pending: pendentes, expired_leases: leaseVencida, failed_last_24h: falhas24h, poll_seconds: JOBS_POLL_SECONDS });
}

async function checkAssets() {
    // Deploy que subiu sem asset: modelos ONNX/MediaPipe, WASM da visão, os mp3
    // do sound check. Nenhum deles é código, todos são obrigatórios, e o boot
    // não os confere.
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
    let ffmpeg = null;
    try {
        const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 2000 });
        ffmpeg = r.status === 0 ? (r.stdout.split("\n")[0] || "").replace(/^ffmpeg version\s+/, "").split(" ")[0] : null;
    } catch { /* ausente */ }
    const faltando = arquivos.filter(a => !a.ok).map(a => a.path);
    const status = (faltando.length || mp3 < 10 || !ffmpeg) ? "fail" : "ok";
    return resultado(status, { missing: faltando, soundcheck_mp3: mp3, soundcheck_expected: 10, ffmpeg });
}

async function checkConsent() {
    // Informativo: qual termo está ativo e quantos alunos aceitaram uma versão
    // anterior. Versão nova é outro termo (#346); saber quantos vão reaceitar
    // evita surpresa depois de publicar.
    let anteriores = null;
    try {
        anteriores = await contar(
            `SELECT count(*)::int AS n FROM submissions WHERE consent_version IS NOT NULL AND consent_version <> '${CONSENT_VERSION}'`
        );
    } catch (err) {
        if (!tabelaAusente(err)) throw err;
    }
    return resultado("ok", { version: CONSENT_VERSION, submissions_on_older_version: anteriores });
}

// Registro. A ordem é a ordem de exibição na tela e no relatório.
export const CHECKS = [
    { id: "config",     label: "Configuração ativa",            level: "shallow", run: checkConfig },
    { id: "db",         label: "Banco de dados",                level: "shallow", run: checkDb },
    { id: "migrations", label: "Migrations pendentes",          level: "shallow", run: checkMigrations },
    { id: "seeds",      label: "Seeds e admin de bootstrap",    level: "shallow", run: checkSeeds },
    { id: "jobs",       label: "Filas (vídeo e retranscrição)", level: "shallow", run: checkJobs },
    { id: "assets",     label: "Binários e modelos",            level: "shallow", run: checkAssets },
    { id: "consent",    label: "Termo de consentimento",        level: "shallow", run: checkConsent },
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

async function comPrazo(promise, ms) {
    let timer;
    const prazo = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`prazo de ${ms} ms estourado`)), ms); });
    try { return await Promise.race([promise, prazo]); }
    finally { clearTimeout(timer); }
}

async function executarUm(check) {
    const t0 = Date.now();
    try {
        const r = await comPrazo(check.run(), SHALLOW_TIMEOUT_MS);
        return { id: check.id, label: check.label, status: r.status, duration_ms: Date.now() - t0, detail: r.detail ?? {}, cost_usd: 0 };
    } catch (err) {
        log.warn("HEALTH", `check ${check.id} falhou: ${err.message}`);
        return { id: check.id, label: check.label, status: "fail", duration_ms: Date.now() - t0, detail: { error: err.message }, cost_usd: 0 };
    }
}

// Roda os checks pedidos (todos os do nível, por padrão), EM PARALELO — são
// independentes e a monitoração quer resposta rápida. Devolve o corpo completo
// do contrato do endpoint; quem chama decide o status HTTP a partir de `status`.
export async function runHealth({ ids = null, depth = "shallow" } = {}) {
    if (!DEPTHS.includes(depth)) throw Object.assign(new Error(`depth inválido: ${depth}`), { httpStatus: 400 });
    if (depth !== "shallow") {
        throw Object.assign(new Error(`nível "${depth}" ainda não implementado neste corte — só "shallow"`), { httpStatus: 501 });
    }
    const escolhidos = CHECKS.filter(c => c.level === depth && (!ids || ids.includes(c.id)));
    if (ids) {
        const desconhecidos = ids.filter(i => !CHECK_IDS.includes(i));
        if (desconhecidos.length) throw Object.assign(new Error(`checks desconhecidos: ${desconhecidos.join(", ")}`), { httpStatus: 400 });
    }
    const t0 = Date.now();
    const checks = await Promise.all(escolhidos.map(executarUm));
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
}

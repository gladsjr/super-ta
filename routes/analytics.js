// Endpoint de ANÁLISE somente-leitura (POST /api/analytics/query).
//
// Dá acesso consultável, seguro e auditável aos dados de PRODUÇÃO para
// benchmark — o gargalo que fazia os testes rodarem só sobre o banco local.
// Ver migration 052 (schema `analytics` de views + opt-out + log).
//
// SEGURANÇA (o backstop é o Postgres, não este código):
//   - Toda consulta roda numa transação `READ ONLY` → o próprio Postgres recusa
//     qualquer escrita/DDL (garantia dura, não checagem furável de string).
//   - `search_path = analytics` → nomes sem qualificação resolvem para as VIEWS
//     seguras (sem PII), nunca para as tabelas-base. Referência explícita a
//     outros schemas (public/pg_catalog/…) é rejeitada antes de executar.
//   - `statement_timeout` curto + LIMIT forçado protegem o banco de produção.
//   - Autenticação por TOKEN gerado pelo admin (migration 053): bearer → hash
//     sha256 → busca em analytics_tokens (vivo = não revogado + não expirado).
//     Sem token válido, 401 — se nenhum token foi gerado, tudo é 401 (fechado
//     por padrão). Nada de variável de ambiente / Replit Secret.
//   - Log de auditoria de TODA consulta (analytics_query_log), fora da tx RO.

import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { pool } from "../auth.js";
import * as db from "../lib/db.js";
import log from "../lib/logger.js";

const router = express.Router();

const ROW_CAP_DEFAULT = 1000;
const ROW_CAP_MAX = 5000;
const STATEMENT_TIMEOUT = "5s";

// Autenticação por token do banco (gerado no admin). Bearer no Authorization
// (ou X-Api-Key). O texto puro nunca é guardado — comparamos pelo hash.
async function requireAnalyticsToken(req, res, next) {
    const hdr = req.get("authorization") || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const provided = bearer || req.get("x-api-key") || "";
    if (!provided) return res.status(401).json({ error: "informe um bearer token (gere um na tela de administração)" });
    try {
        const hash = crypto.createHash("sha256").update(provided).digest("hex");
        const row = await db.findValidAnalyticsToken(hash);
        if (!row) return res.status(401).json({ error: "token inválido, revogado ou expirado" });
        req.analyticsToken = row;
        next();
    } catch (e) {
        log.error("ANALYTICS", `auth falhou: ${e.message}`);
        res.status(500).json({ error: "erro de autenticação" });
    }
}

// ---- Consultas NOMEADAS (allowlist versionada) ---------------------------
// Cada uma é uma função (params) -> { text, values } com SQL parametrizado
// sobre as views `analytics.*`. Cobrem os recortes recorrentes de benchmark.
const SINCE = (p) => (p && p.since ? p.since : "1970-01-01");
const NAMED = {
    // Custo/tokens agregado por tipo de trabalho e variante de entrevista.
    cost_by_kind: (p) => ({
        text: `SELECT w.kind, w.interview_variant,
                      count(DISTINCT e.submission_id) AS submissions,
                      sum(e.input_tokens) AS input_tokens,
                      sum(e.cached_tokens) AS cached_tokens,
                      sum(e.output_tokens) AS output_tokens,
                      round(sum(e.cost_usd), 4) AS cost_usd
               FROM analytics.cost_events e
               JOIN analytics.works w ON w.id = e.work_id
               WHERE e.created_at >= $1
               GROUP BY 1, 2 ORDER BY cost_usd DESC NULLS LAST`,
        values: [SINCE(p)],
    }),
    // Custo/tokens por modelo e tipo de evento.
    cost_by_model: (p) => ({
        text: `SELECT model, event_type,
                      count(*) AS calls,
                      sum(input_tokens) AS input_tokens,
                      sum(cached_tokens) AS cached_tokens,
                      sum(output_tokens) AS output_tokens,
                      round(sum(cost_usd), 4) AS cost_usd
               FROM analytics.cost_events
               WHERE created_at >= $1
               GROUP BY 1, 2 ORDER BY cost_usd DESC NULLS LAST`,
        values: [SINCE(p)],
    }),
    // Custo por submissão (média e percentis) por tipo de trabalho.
    cost_per_submission: (p) => ({
        text: `WITH per_sub AS (
                   SELECT e.submission_id, w.kind, sum(e.cost_usd) AS cost
                   FROM analytics.cost_events e
                   JOIN analytics.works w ON w.id = e.work_id
                   WHERE e.created_at >= $1 AND e.submission_id IS NOT NULL
                   GROUP BY 1, 2)
               SELECT kind, count(*) AS submissions,
                      round(avg(cost), 4) AS avg_cost,
                      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY cost))::numeric, 4) AS p50_cost,
                      round((percentile_cont(0.95) WITHIN GROUP (ORDER BY cost))::numeric, 4) AS p95_cost
               FROM per_sub GROUP BY 1 ORDER BY avg_cost DESC NULLS LAST`,
        values: [SINCE(p)],
    }),
    // Estatística de turnos por entrevista (p50/p95), por tipo e variante.
    interview_turn_stats: (p) => ({
        text: `SELECT w.kind, w.interview_variant,
                      count(*) AS submissions,
                      round(avg(s.turn_count), 1) AS avg_turns,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY s.turn_count) AS p50_turns,
                      percentile_cont(0.95) WITHIN GROUP (ORDER BY s.turn_count) AS p95_turns
               FROM analytics.submissions s
               JOIN analytics.works w ON w.id = s.work_id
               WHERE s.created_at >= $1 AND NOT s.is_test
               GROUP BY 1, 2 ORDER BY submissions DESC`,
        values: [SINCE(p)],
    }),
    // Distribuição de notas finais.
    grade_distribution: (p) => ({
        text: `SELECT w.kind, floor(s.grade_final)::int AS grade_bucket, count(*) AS n
               FROM analytics.submissions s
               JOIN analytics.works w ON w.id = s.work_id
               WHERE s.grade_final IS NOT NULL AND s.created_at >= $1
               GROUP BY 1, 2 ORDER BY 1, 2`,
        values: [SINCE(p)],
    }),
    // Motivos de encerramento.
    completion_reasons: (p) => ({
        text: `SELECT completion_reason, count(*) AS n
               FROM analytics.submissions
               WHERE created_at >= $1
               GROUP BY 1 ORDER BY n DESC`,
        values: [SINCE(p)],
    }),
    // Trabalhos recentes de PRODUÇÃO (não-benchmark) com gasto/orçamento.
    recent_works: (p) => ({
        text: `SELECT work_token, name, kind, interview_variant, question_count,
                      budget_usd, spent_usd, created_at
               FROM analytics.works
               WHERE NOT is_benchmark AND created_at >= $1
               ORDER BY created_at DESC`,
        values: [SINCE(p)],
    }),
    // Submissões mais caras (top-N).
    expensive_submissions: (p) => ({
        text: `SELECT e.submission_id, w.kind, w.work_token,
                      round(sum(e.cost_usd), 4) AS cost_usd,
                      sum(e.output_tokens) AS output_tokens
               FROM analytics.cost_events e
               JOIN analytics.works w ON w.id = e.work_id
               WHERE e.created_at >= $1 AND e.submission_id IS NOT NULL
               GROUP BY 1, 2, 3 ORDER BY cost_usd DESC NULLS LAST`,
        values: [SINCE(p)],
    }),
    // (Nível 2) Turnos de uma submissão — passe { submission_id }.
    conversation_sample: (p) => ({
        text: `SELECT turn_index, interviewer_text, student_text, asked_at, answered_at, spontaneous
               FROM analytics.conversation_turns
               WHERE submission_id = $1
               ORDER BY turn_index`,
        values: [Number(p && p.submission_id)],
    }),
};

// ---- Guarda do SQL ad-hoc -------------------------------------------------
// Aceita SÓ um único SELECT/WITH sobre as views analytics.*; rejeita referência
// explícita a outros schemas e a catálogos do sistema. É a 1ª barreira; a
// transação READ ONLY + search_path são a garantia dura por trás.
function sanitizeAdhoc(sql) {
    let s = String(sql || "").trim().replace(/;+\s*$/, "");
    if (!s) throw new Error("sql vazio");
    if (s.includes(";")) throw new Error("apenas um comando (sem ';')");
    if (!/^(select|with)\b/i.test(s)) throw new Error("apenas SELECT/WITH");
    if (/\b(public|pg_catalog|information_schema|pg_temp|pg_toast)\b/i.test(s)) throw new Error("referência a schema não permitido");
    if (/\bpg_[a-z_]+/i.test(s)) throw new Error("acesso a objeto de sistema (pg_*) não permitido");
    return s;
}

// Executa dentro de uma transação READ ONLY, com search_path e timeout locais,
// embrulhando em LIMIT (cap+1 p/ detectar truncamento). Não escreve nada.
async function runReadOnly(text, values, cap) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION READ ONLY");
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await client.query("SET LOCAL search_path = analytics");
        const wrapped = `SELECT * FROM ( ${text} ) AS _analytics_q LIMIT ${cap + 1}`;
        const r = await client.query({ text: wrapped, values: values || [] });
        await client.query("COMMIT");
        return r;
    } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* noop */ }
        throw e;
    } finally {
        client.release();
    }
}

async function auditLog(entry) {
    try {
        await pool.query(
            `INSERT INTO analytics_query_log (actor, mode, query, params_json, row_count, truncated, duration_ms, ok, error)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [entry.actor || "claude", entry.mode, entry.query, entry.params ? JSON.stringify(entry.params) : null,
             entry.rowCount ?? null, entry.truncated ?? null, entry.durationMs ?? null, entry.ok, entry.error || null]
        );
    } catch (e) {
        log.warn("ANALYTICS", `falha ao gravar auditoria: ${e.message}`);
    }
}

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "muitas consultas — aguarde um instante" },
});

// POST /api/analytics/query
// body (nomeada): { "query": "cost_by_kind", "params": {...}, "limit": 500 }
// body (ad-hoc):  { "sql": "SELECT ... FROM works ...", "limit": 1000 }
router.post("/api/analytics/query", limiter, requireAnalyticsToken, async (req, res) => {
    const t0 = Date.now();
    const actor = `token:${req.analyticsToken?.id ?? "?"}`;
    const cap = Math.min(ROW_CAP_MAX, Math.max(1, Number(req.body?.limit) || ROW_CAP_DEFAULT));
    const isNamed = typeof req.body?.query === "string" && req.body.query.length > 0;
    const mode = isNamed ? "named" : "adhoc";
    let queryLabel = "";
    try {
        let text, values;
        if (isNamed) {
            const builder = NAMED[req.body.query];
            if (!builder) return res.status(400).json({ error: `consulta nomeada desconhecida: ${req.body.query}`, available: Object.keys(NAMED) });
            queryLabel = req.body.query;
            ({ text, values } = builder(req.body.params || {}));
        } else if (typeof req.body?.sql === "string") {
            text = sanitizeAdhoc(req.body.sql);
            values = Array.isArray(req.body.params) ? req.body.params : [];
            queryLabel = text;
        } else {
            return res.status(400).json({ error: "informe 'query' (nomeada) ou 'sql' (ad-hoc)" });
        }

        const r = await runReadOnly(text, values, cap);
        const truncated = r.rows.length > cap;
        const rows = truncated ? r.rows.slice(0, cap) : r.rows;
        const durationMs = Date.now() - t0;
        const columns = (r.fields || []).map(f => f.name);
        await auditLog({ actor, mode, query: queryLabel, params: req.body?.params, rowCount: rows.length, truncated, durationMs, ok: true });
        res.json({ columns, rows, row_count: rows.length, truncated, duration_ms: durationMs });
    } catch (err) {
        const durationMs = Date.now() - t0;
        await auditLog({ actor, mode, query: queryLabel || (req.body?.query || req.body?.sql || ""), params: req.body?.params, ok: false, durationMs, error: err.message });
        log.warn("ANALYTICS", `query falhou (${mode}): ${err.message}`);
        // 400 para erros de guarda/SQL; a msg do Postgres ajuda a depurar a consulta.
        res.status(400).json({ error: err.message });
    }
});

export default router;

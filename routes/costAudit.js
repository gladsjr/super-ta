// Rotas de AUDITORIA DE CUSTO (admin). Reconcilia o custo calculado localmente
// (work_cost_events) contra o consumo real da OpenAI (Usage/Costs API). Ver
// lib/costAudit.js e migration 048. Namespace próprio (/api/cost-audit) para não
// colidir com o harness de comparação de modelos (/api/benchmark, "ORATIA Bench").

import express from "express";
import { requireAdmin } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { fetchBenchmarkUsage, fetchProjectCosts, buildReconciliation } from "../lib/costAudit.js";
import log from "../lib/logger.js";

const router = express.Router();

// Aceita ISO-8601, epoch em segundos ou milissegundos, ou Date. Retorna epoch (s).
function toUnixSeconds(v) {
    if (v == null) return null;
    if (v instanceof Date) return Math.floor(v.getTime() / 1000);
    if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    const n = Number(v);
    if (Number.isFinite(n) && String(v).trim() !== "") return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new Error(`data inválida: ${v}`);
    return Math.floor(t / 1000);
}

// Deriva a janela [start,end) em epoch-segundos a partir do run (min/max
// created_at dos eventos) ou dos parâmetros explícitos. Sem run e sem janela → erro.
async function resolveWindow({ benchmarkRunId, startTime, endTime }) {
    let startS = startTime != null ? toUnixSeconds(startTime) : null;
    let endS = endTime != null ? toUnixSeconds(endTime) : null;
    if ((startS == null || endS == null) && benchmarkRunId) {
        const w = await db.benchmarkRunWindow(benchmarkRunId);
        if (!w || !w.start_time) throw new Error(`run "${benchmarkRunId}" não tem eventos de custo ainda`);
        if (startS == null) startS = Math.floor(new Date(w.start_time).getTime() / 1000);
        // +120s de folga: a Usage bucketiza e o último evento pode encostar no fim.
        if (endS == null) endS = Math.floor(new Date(w.end_time).getTime() / 1000) + 120;
    }
    if (startS == null || endS == null) throw new Error("informe benchmark_run_id OU start_time+end_time");
    if (endS <= startS) endS = startS + 60;
    return { startS, endS };
}

// Coleta os dois lados (calculado + real) e monta o objeto de reconciliação.
async function reconcile({ benchmarkRunId, startS, endS, skipCosts }) {
    const calculatedRows = await db.aggregateCalculatedCost({
        benchmarkRunId: benchmarkRunId || null,
        startTime: new Date(startS * 1000).toISOString(),
        endTime: new Date(endS * 1000).toISOString(),
    });

    const notes = [];
    let usageLines = [];
    try {
        const u = await fetchBenchmarkUsage({ startTime: startS, endTime: endS });
        usageLines = u.lines;
        notes.push(...u.notes);
    } catch (err) {
        notes.push(`Usage API indisponível: ${err.message}`);
        log.warn("COST_AUDIT", `Usage indisponível: ${err.message}`);
    }

    let projectCosts = null;
    if (!skipCosts) {
        try {
            projectCosts = await fetchProjectCosts({ startTime: startS, endTime: endS });
        } catch (err) {
            notes.push(`Costs API indisponível: ${err.message}`);
            log.warn("COST_AUDIT", `Costs indisponível: ${err.message}`);
        }
    }

    return buildReconciliation({
        benchmarkRunId: benchmarkRunId || null,
        windowStart: new Date(startS * 1000).toISOString(),
        windowEnd: new Date(endS * 1000).toISOString(),
        calculatedRows, usageLines, projectCosts, notes,
    });
}

// POST /api/cost-audit/run — dispara uma reconciliação e PERSISTE o resultado.
// body: { benchmark_run_id?, start_time?, end_time?, skip_costs?, persist? }
router.post("/api/cost-audit/run", requireAdmin, express.json({ limit: "16kb" }), async (req, res) => {
    try {
        const benchmarkRunId = req.body?.benchmark_run_id || null;
        const { startS, endS } = await resolveWindow({
            benchmarkRunId, startTime: req.body?.start_time, endTime: req.body?.end_time,
        });
        const recon = await reconcile({ benchmarkRunId, startS, endS, skipCosts: req.body?.skip_costs === true });
        const persist = req.body?.persist !== false; // default: persiste
        const saved = persist ? await db.insertCostAudit(recon) : recon;
        log.info("COST_AUDIT", `run reconciled run=${benchmarkRunId ?? "-"} calc=$${Number(recon.calculatedUsd).toFixed(4)} ref=${recon.referenceUsd == null ? "-" : "$" + Number(recon.referenceUsd).toFixed(4)} delta=${recon.deltaPct == null ? "-" : recon.deltaPct.toFixed(1) + "%"}`);
        res.json({ audit: saved });
    } catch (err) {
        log.error("COST_AUDIT", `run failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// GET /api/cost-audit — lista as auditorias (mais recentes primeiro).
router.get("/api/cost-audit", requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const audits = await db.listCostAudits(limit);
        res.json({ audits });
    } catch (err) {
        log.error("COST_AUDIT", `list failed: ${err.message}`);
        res.status(500).json({ error: "failed to list cost audits" });
    }
});

// GET /api/cost-audit/:id — detalhe de uma auditoria.
router.get("/api/cost-audit/:id", requireAdmin, async (req, res) => {
    try {
        const audit = await db.getCostAudit(Number(req.params.id));
        if (!audit) return res.status(404).json({ error: "not found" });
        res.json({ audit });
    } catch (err) {
        log.error("COST_AUDIT", `get failed: ${err.message}`);
        res.status(500).json({ error: "failed to get cost audit" });
    }
});

// POST /api/cost-audit/:id/settle — 2ª camada: re-busca Usage+Costs para a MESMA
// janela e fecha (status settled). Use no dia seguinte, quando a Costs fechou.
router.post("/api/cost-audit/:id/settle", requireAdmin, async (req, res) => {
    try {
        const audit = await db.getCostAudit(Number(req.params.id));
        if (!audit) return res.status(404).json({ error: "not found" });
        const startS = Math.floor(new Date(audit.window_start).getTime() / 1000);
        const endS = Math.floor(new Date(audit.window_end).getTime() / 1000);
        const recon = await reconcile({ benchmarkRunId: audit.benchmark_run_id, startS, endS, skipCosts: false });
        const updated = await db.settleCostAudit(audit.id, {
            actualUsageTokensJson: recon.actualUsageTokensJson,
            referenceUsd: recon.referenceUsd,
            costsApiProjectUsd: recon.costsApiProjectUsd,
            deltaTokensJson: recon.deltaTokensJson,
            deltaUsd: recon.deltaUsd,
            deltaPct: recon.deltaPct,
            status: "settled",
            note: recon.note,
        });
        res.json({ audit: updated });
    } catch (err) {
        log.error("COST_AUDIT", `settle failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

export default router;

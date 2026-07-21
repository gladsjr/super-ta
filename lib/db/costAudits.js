// Persistência das auditorias de custo (tabela cost_audits, migration 048).
// A auditoria reconcilia o custo CALCULADO (work_cost_events) contra o consumo
// REAL da OpenAI (Usage/Costs API). Ver lib/costAudit.js.

import { pool } from "../../auth.js";

// Agrega o lado CALCULADO: soma work_cost_events dos works de um run de benchmark
// (ou de todos os works de benchmark, se runId nulo) dentro da janela [start,end).
// Agrupa por (model, event_type) → tokens e custo somados. `created_at` do evento
// delimita a janela (é quando a chamada ocorreu).
export async function aggregateCalculatedCost({ benchmarkRunId = null, startTime, endTime }) {
    const params = [startTime, endTime];
    let runFilter = "";
    if (benchmarkRunId) {
        params.push(benchmarkRunId);
        runFilter = `AND w.benchmark_run_id = $${params.length}`;
    }
    const r = await pool.query(
        `SELECT e.model,
                e.event_type,
                COALESCE(SUM(e.input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(e.cached_tokens), 0) AS cached_tokens,
                COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(e.audio_seconds), 0) AS audio_seconds,
                COALESCE(SUM(e.audio_chars), 0)   AS audio_chars,
                COALESCE(SUM(e.cost_usd), 0)      AS cost_usd,
                COUNT(*)                          AS events
           FROM work_cost_events e
           JOIN works w ON w.id = e.work_id
          WHERE w.is_benchmark = true
            AND e.created_at >= $1 AND e.created_at < $2
            ${runFilter}
          GROUP BY e.model, e.event_type
          ORDER BY e.model, e.event_type`,
        params
    );
    return r.rows;
}

// Janela temporal coberta pelos works de um run (min/max created_at dos eventos).
// Útil para auto-derivar a janela da Usage/Costs API a partir do run.
export async function benchmarkRunWindow(benchmarkRunId) {
    const r = await pool.query(
        `SELECT MIN(e.created_at) AS start_time, MAX(e.created_at) AS end_time, COUNT(*) AS events
           FROM work_cost_events e
           JOIN works w ON w.id = e.work_id
          WHERE w.is_benchmark = true AND w.benchmark_run_id = $1`,
        [benchmarkRunId]
    );
    return r.rows[0] || null;
}

export async function insertCostAudit(a) {
    const r = await pool.query(
        `INSERT INTO cost_audits (
            benchmark_run_id, window_start, window_end,
            calculated_usd, calculated_tokens_json,
            actual_usage_tokens_json, reference_usd, costs_api_project_usd,
            delta_tokens_json, delta_usd, delta_pct, status, note, settled_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
            a.benchmarkRunId ?? null, a.windowStart, a.windowEnd,
            a.calculatedUsd ?? 0, a.calculatedTokensJson ?? {},
            a.actualUsageTokensJson ?? null, a.referenceUsd ?? null, a.costsApiProjectUsd ?? null,
            a.deltaTokensJson ?? null, a.deltaUsd ?? null, a.deltaPct ?? null,
            a.status ?? "pending", a.note ?? null, a.settledAt ?? null,
        ]
    );
    return r.rows[0];
}

export async function listCostAudits(limit = 50) {
    const r = await pool.query(
        `SELECT * FROM cost_audits ORDER BY created_at DESC LIMIT $1`,
        [limit]
    );
    return r.rows;
}

export async function getCostAudit(id) {
    const r = await pool.query(`SELECT * FROM cost_audits WHERE id = $1`, [id]);
    return r.rows[0] || null;
}

// Fecho (2ª camada): atualiza o registro com os números reais/faturados quando a
// Costs API do dia fechou. Vira status 'settled'.
export async function settleCostAudit(id, patch) {
    const r = await pool.query(
        `UPDATE cost_audits SET
            actual_usage_tokens_json = COALESCE($2, actual_usage_tokens_json),
            reference_usd            = COALESCE($3, reference_usd),
            costs_api_project_usd    = COALESCE($4, costs_api_project_usd),
            delta_tokens_json        = COALESCE($5, delta_tokens_json),
            delta_usd                = COALESCE($6, delta_usd),
            delta_pct                = COALESCE($7, delta_pct),
            status                   = $8,
            note                     = COALESCE($9, note),
            settled_at               = now()
          WHERE id = $1
          RETURNING *`,
        [id, patch.actualUsageTokensJson ?? null, patch.referenceUsd ?? null,
         patch.costsApiProjectUsd ?? null, patch.deltaTokensJson ?? null,
         patch.deltaUsd ?? null, patch.deltaPct ?? null,
         patch.status ?? "settled", patch.note ?? null]
    );
    return r.rows[0] || null;
}

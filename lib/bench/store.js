import { pool } from "../../auth.js";

export async function createRun({ runKey, config, userId, progressTotal, releaseKey = null, candidateFingerprint = null }) {
    await pool.query(
        `INSERT INTO benchmark_runs
         (run_key, benchmark, setup_version, context_version, jury_version, mode, status, config_json, created_by, progress_total, release_key, candidate_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11)`,
        [runKey, config.benchmark, config.setup_version, config.context_version, config.jury_version, config.mode, config, userId || null, progressTotal, releaseKey, candidateFingerprint]
    );
}

export async function markRunning(runKey) {
    await pool.query("UPDATE benchmark_runs SET status='running', started_at=now() WHERE run_key=$1", [runKey]);
}

export async function updateProgress(runKey, done) {
    await pool.query("UPDATE benchmark_runs SET progress_done=$2 WHERE run_key=$1", [runKey, done]);
}

export async function completeRun(runKey, result, raw) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE benchmark_runs SET status='completed', finished_at=now(), progress_done=progress_total,
             summary_json=$2, metrics_json=$3, artifact_dir=$4 WHERE run_key=$1`,
            [runKey, result.run, result.metrics, result.runDir]
        );
        for (const item of raw.outputs) {
            await client.query(
                `INSERT INTO benchmark_model_outputs
                 (run_key,case_id,turn_id,candidate_key,output_text,usage_json,latency_ms,cost_estimated_usd,cost_source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [runKey, item.case_id, item.turn_id, item.candidate_key, item.text, item.usage || {}, item.latency_ms, item.cost_estimated_usd, item.cost_source || "estimated"]
            );
        }
        for (const item of raw.judgments) {
            await client.query(
                `INSERT INTO benchmark_judgments
                 (run_key,case_id,turn_id,candidate_key,judge_key,candidate_position,score_general,dimensions_json,confidence,critical_failure,rationale)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [runKey, item.case_id, item.turn_id, item.candidate_key, item.judge_key, item.candidate_position, item.score, item.dimensions || {}, item.confidence, item.critical_failure, item.rationale]
            );
        }
        for (const item of raw.consensus || []) {
            await client.query(
                `INSERT INTO benchmark_consensus
                 (run_key,case_id,turn_id,candidate_key,score_general,dimensions_json,confidence,critical_failure,judge_count,agreement_json,needs_deliberation)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [runKey, item.case_id, item.turn_id, item.candidate_key, item.score, item.dimensions || {}, item.confidence, item.critical_failure, item.judge_count, item.agreement || {}, item.needs_deliberation]
            );
        }
        for (const item of raw.ledger) {
            await client.query(
                `INSERT INTO benchmark_call_ledger
                 (run_key,call_key,provider,model,effort,role,case_id,turn_id,candidate_key,request_hash,response_hash,usage_json,latency_ms,cost_estimated_usd,cost_source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                [runKey, item.id, item.provider, item.model, item.effort, item.role, item.case_id, item.turn_id, item.candidate_key || null, item.request_hash, item.response_hash, item.usage || {}, item.latency_ms, item.cost_estimated_usd, item.cost_source || "estimated"]
            );
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function failRun(runKey, error, status = "failed") {
    await pool.query("UPDATE benchmark_runs SET status=$2, error_text=$3, finished_at=now() WHERE run_key=$1", [runKey, status, String(error?.stack || error?.message || error).slice(0, 12000)]);
}

export async function listRuns(limit = 100) {
    const result = await pool.query(
        `SELECT r.*, u.username AS created_by_username
         FROM benchmark_runs r LEFT JOIN users u ON u.id=r.created_by
         ORDER BY r.created_at DESC LIMIT $1`,
        [Math.min(500, Math.max(1, Number(limit) || 100))]
    );
    return result.rows;
}

export async function getRun(runKey) {
    const result = await pool.query(
        `SELECT r.*, u.username AS created_by_username
         FROM benchmark_runs r LEFT JOIN users u ON u.id=r.created_by WHERE r.run_key=$1`,
        [runKey]
    );
    return result.rows[0] || null;
}

export async function getRunDetails(runKey) {
    const [run, outputs, judgments, consensus, ledger] = await Promise.all([
        getRun(runKey),
        pool.query("SELECT * FROM benchmark_model_outputs WHERE run_key=$1 ORDER BY case_id,turn_id,candidate_key", [runKey]),
        pool.query("SELECT * FROM benchmark_judgments WHERE run_key=$1 ORDER BY case_id,turn_id,candidate_key,judge_key", [runKey]),
        pool.query("SELECT * FROM benchmark_consensus WHERE run_key=$1 ORDER BY case_id,turn_id,candidate_key", [runKey]),
        pool.query("SELECT * FROM benchmark_call_ledger WHERE run_key=$1 ORDER BY id", [runKey]),
    ]);
    return run ? { run, outputs: outputs.rows, judgments: judgments.rows, consensus: consensus.rows, ledger: ledger.rows } : null;
}

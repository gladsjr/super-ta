// Fila de jobs no banco (issue #289, corte 3). Ver migrations/078_jobs.sql
// para o racional. API mínima: enqueue → claim (atômico, com lease) →
// complete/fail. Agnóstica de executor — o app hoje, um worker externo amanhã.

import { pool } from "../auth.js";
import log from "./logger.js";

const LEASE_MINUTES = 90; // teto generoso: um whisper local de sessão longa cabe

export async function enqueueJob(type, { submissionId = null, payload = {}, maxAttempts = 3 } = {}) {
    const r = await pool.query(
        `INSERT INTO jobs (type, submission_id, payload, max_attempts)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [type, submissionId, JSON.stringify(payload), maxAttempts]
    );
    return r.rows[0].id;
}

// Reivindica O PRÓXIMO job elegível do(s) tipo(s) dados, atomicamente:
// pending, ou running com lease vencida (executor morreu no meio). SKIP LOCKED
// garante que dois executores nunca pegam o mesmo job. attempts esgotadas
// viram 'failed' na passada (sem processar). Devolve o job ou null.
export async function claimNextJob(types) {
    const r = await pool.query(
        `WITH candidato AS (
            SELECT id FROM jobs
             WHERE type = ANY($1)
               AND (status = 'pending' OR (status = 'running' AND lease_until < now()))
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
        )
        UPDATE jobs j
           SET status = CASE WHEN j.attempts >= j.max_attempts THEN 'failed' ELSE 'running' END,
               attempts = j.attempts + 1,
               last_error = CASE WHEN j.attempts >= j.max_attempts
                   THEN COALESCE(j.last_error, '') || ' [tentativas esgotadas]' ELSE j.last_error END,
               lease_until = now() + interval '${LEASE_MINUTES} minutes',
               updated_at = now()
          FROM candidato c
         WHERE j.id = c.id
        RETURNING j.id, j.type, j.submission_id, j.payload, j.status, j.attempts`,
        [types]
    );
    const job = r.rows[0] || null;
    if (job && job.status === "failed") {
        log.warn("JOBS", `job ${job.id} (${job.type}) esgotou as tentativas — marcado failed`);
        return claimNextJob(types); // pula para o próximo elegível
    }
    return job;
}

export async function completeJob(id, result = null) {
    await pool.query(
        `UPDATE jobs SET status = 'done', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
        [id, result ? JSON.stringify(result) : null]
    );
}

// Falha REtentável: volta a pending (o claim futuro re-tenta até max_attempts).
export async function failJob(id, errMessage) {
    await pool.query(
        `UPDATE jobs SET status = 'pending', last_error = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
        [id, String(errMessage || "").slice(0, 500)]
    );
}

// Visibilidade (admin/diagnóstico).
export async function jobsSnapshot() {
    const r = await pool.query(
        `SELECT type, status, count(*)::int AS n FROM jobs GROUP BY 1, 2 ORDER BY 1, 2`
    );
    return r.rows;
}

// Fila de jobs no banco (issue #289, corte 3). Ver migrations/078_jobs.sql
// para o racional. API mínima: enqueue → claim (atômico, com lease) →
// complete/fail. Agnóstica de executor — o app hoje, um worker externo amanhã.

import { pool } from "../auth.js";
import log from "./logger.js";

const LEASE_MINUTES = 90; // teto generoso: um whisper local de sessão longa cabe

// priority: menor = primeiro (migration 079). Dedup por (type, submission_id)
// ativo: enfileirar o que já está pending/running devolve o job EXISTENTE
// ({ id, existed: true }) — era o dedup em memória da fila de vídeo.
export async function enqueueJob(type, { submissionId = null, payload = {}, maxAttempts = 3, priority = 100 } = {}) {
    const r = await pool.query(
        `INSERT INTO jobs (type, submission_id, payload, max_attempts, priority)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (type, submission_id) WHERE status IN ('pending', 'running') AND submission_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [type, submissionId, JSON.stringify(payload), maxAttempts, priority]
    );
    if (r.rows[0]) return { id: r.rows[0].id, existed: false };
    const ex = await pool.query(
        `SELECT id FROM jobs WHERE type = $1 AND submission_id = $2 AND status IN ('pending', 'running') LIMIT 1`,
        [type, submissionId]
    );
    return { id: ex.rows[0]?.id ?? null, existed: true };
}

// Fura fila: rebaixa o número de prioridade de um job ainda pendente.
export async function reprioritizeJob(id, priority) {
    const r = await pool.query(
        `UPDATE jobs SET priority = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`,
        [id, priority]
    );
    return r.rowCount > 0;
}

// O job ativo (pending/running) de um tipo para uma submissão, se houver.
export async function findActiveJob(type, submissionId) {
    const r = await pool.query(
        `SELECT id, status, priority, attempts, payload, created_at FROM jobs
          WHERE type = $1 AND submission_id = $2 AND status IN ('pending', 'running') LIMIT 1`,
        [type, submissionId]
    );
    return r.rows[0] || null;
}

// Um job qualquer por id (polling de desfecho — enqueueProctorAndWait).
export async function getJob(id) {
    const r = await pool.query(`SELECT id, type, status, attempts, last_error FROM jobs WHERE id = $1`, [id]);
    return r.rows[0] || null;
}

// Jobs pendentes de um tipo, na ordem real de execução (snapshot do Operações).
export async function listPendingJobs(type) {
    const r = await pool.query(
        `SELECT id, submission_id, priority, attempts, payload, created_at FROM jobs
          WHERE type = $1 AND status = 'pending'
          ORDER BY priority ASC, created_at ASC`,
        [type]
    );
    return r.rows;
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
             ORDER BY priority ASC, created_at ASC
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
// terminal: true marca 'failed' direto — lanes SEM retentativa automática
// (vídeo: reprocessar é sempre um ato humano).
export async function failJob(id, errMessage, { terminal = false } = {}) {
    await pool.query(
        `UPDATE jobs SET status = $3, last_error = $2, lease_until = NULL, updated_at = now() WHERE id = $1`,
        [id, String(errMessage || "").slice(0, 500), terminal ? "failed" : "pending"]
    );
}

// Visibilidade (admin/diagnóstico).
export async function jobsSnapshot() {
    const r = await pool.query(
        `SELECT type, status, count(*)::int AS n FROM jobs GROUP BY 1, 2 ORDER BY 1, 2`
    );
    return r.rows;
}

// --- Falhas acionáveis no Operações (#311) ---
// Lista as falhas com contexto legível (quem/qual trabalho/causa/quando).
// A lane de VÍDEO fica FORA (#338): a fila de análises tem card e ações
// próprios no Operações — misturar aqui duplicaria a falha em dois lugares.
export async function listFailedJobs(limit = 20) {
    const r = await pool.query(
        `SELECT j.id, j.type, j.attempts, j.last_error, j.updated_at,
                s.submission_token, s.student_label,
                w.name AS work_name, w.work_token, w.kind AS work_kind
           FROM jobs j
           LEFT JOIN submissions s ON s.id = j.submission_id
           LEFT JOIN works w ON w.id = s.work_id
          WHERE j.status = 'failed' AND j.type <> 'video_analysis'
          ORDER BY j.updated_at DESC
          LIMIT $1`,
        [limit]
    );
    return r.rows;
}

// Reprocessar: volta a pending com as tentativas ZERADAS (decisão humana de
// tentar de novo — o ciclo de retentativas recomeça inteiro).
export async function retryJob(id) {
    const r = await pool.query(
        `UPDATE jobs SET status = 'pending', attempts = 0, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND status = 'failed'`,
        [id]
    );
    return r.rowCount > 0;
}

// Descartar: sai da contagem de falhas SEM apagar a trilha (status próprio).
export async function discardJob(id) {
    const r = await pool.query(
        `UPDATE jobs SET status = 'discarded', updated_at = now()
          WHERE id = $1 AND status = 'failed'`,
        [id]
    );
    return r.rowCount > 0;
}

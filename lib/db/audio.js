// Artefatos de áudio do aluno (metadados das gravações). Parte do split de
// lib/db.js (ver lib/db.js, que é o barrel que re-exporta tudo). SQL e lógica
// preservados verbatim do módulo monolítico original.

import { pool } from "../../auth.js";

// =============================================================================
// student_audio_artifacts — metadados das gravações do aluno.
// Os bytes vivem no Object Storage; aqui mora só o registro.
// =============================================================================

export async function recordStudentAudioArtifact({
    submissionId,
    audioIdx,
    turnIndex = null,
    interventionIndex = null,
    objectKey,
    mimetype = null,
    byteSize = null,
    durationS = null,
    sha256 = null,
}) {
    const r = await pool.query(
        `INSERT INTO student_audio_artifacts (
            submission_id, audio_idx, turn_index, intervention_index,
            object_key, mimetype, byte_size, duration_s, sha256
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [submissionId, audioIdx, turnIndex, interventionIndex, objectKey, mimetype, byteSize, durationS, sha256]
    );
    return r.rows[0].id;
}

export async function nextAudioIdxForSubmission(submissionId) {
    const r = await pool.query(
        `SELECT COALESCE(MAX(audio_idx), -1) + 1 AS next FROM student_audio_artifacts WHERE submission_id = $1`,
        [submissionId]
    );
    return r.rows[0].next;
}

export async function listStudentAudioArtifactsForSubmission(submissionId) {
    const r = await pool.query(
        `SELECT id, audio_idx, turn_index, intervention_index, object_key,
                mimetype, byte_size, duration_s, sha256, created_at
         FROM student_audio_artifacts
         WHERE submission_id = $1
         ORDER BY audio_idx`,
        [submissionId]
    );
    return r.rows;
}

export async function getStudentAudioArtifact({ submissionId, audioIdx }) {
    const r = await pool.query(
        `SELECT id, audio_idx, turn_index, intervention_index, object_key,
                mimetype, byte_size, duration_s, sha256, created_at
         FROM student_audio_artifacts
         WHERE submission_id = $1 AND audio_idx = $2`,
        [submissionId, audioIdx]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0];
}

export async function deleteStudentAudioArtifactsForSubmission(submissionId) {
    await pool.query(
        `DELETE FROM student_audio_artifacts WHERE submission_id = $1`,
        [submissionId]
    );
}

// Lista submissions cujas gravações estão vencidas (passaram olderThanDays
// desde completed_at). Usado pelo GC. Submissions ainda não finalizadas
// nunca são vencidas, independente do tempo decorrido.
export async function listSubmissionsWithExpiredAudio(olderThanDays) {
    const r = await pool.query(
        `SELECT DISTINCT s.id, s.submission_token, s.completed_at
         FROM submissions s
         JOIN student_audio_artifacts a ON a.submission_id = s.id
         WHERE s.completed_at IS NOT NULL
           AND s.completed_at < (now() - ($1 || ' days')::interval)`,
        [String(olderThanDays)]
    );
    return r.rows;
}

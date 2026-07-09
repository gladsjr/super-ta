// Prova oral (Realtime). Parte do split de lib/db.js (ver lib/db.js, que é o
// barrel que re-exporta tudo). SQL e lógica preservados verbatim do módulo
// monolítico original.

import { pool } from "../../auth.js";

// Perguntas sorteadas/feitas a um aluno específico (subconjunto do gabarito).
export async function setOralAsked(submissionId, questions) {
    await pool.query(
        "UPDATE submissions SET oral_asked_json = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(questions || []), submissionId]
    );
}
export async function getOralAsked(submissionId) {
    const r = await pool.query("SELECT oral_asked_json FROM submissions WHERE id = $1", [submissionId]);
    const q = r.rows[0]?.oral_asked_json;
    return Array.isArray(q) && q.length ? q : null;
}
// Chave do vídeo gravado da prova oral (object storage).
export async function setOralVideoKey(submissionId, key) {
    await pool.query(
        "UPDATE submissions SET oral_video_key = $1, updated_at = now() WHERE id = $2",
        [key || null, submissionId]
    );
}
export async function getOralVideoKey(submissionId) {
    const r = await pool.query("SELECT oral_video_key FROM submissions WHERE id = $1", [submissionId]);
    return r.rows[0]?.oral_video_key || null;
}
// Anexa um SEGMENTO de vídeo (multi-parte: original + cada retomada). Mantém
// oral_video_key = último segmento (compat com has_oral_video e código legado).
export async function appendOralVideoPart(submissionId, key) {
    await pool.query(
        `UPDATE submissions
            SET oral_video_parts = oral_video_parts || to_jsonb($1::text),
                oral_video_key = $1,
                updated_at = now()
          WHERE id = $2`,
        [key, submissionId]
    );
}
// Lista ordenada das chaves de segmento. Fallback para [oral_video_key] cobre
// linhas anteriores ao backfill (defensivo; a migration 035 já faz o backfill).
export async function getOralVideoParts(submissionId) {
    const r = await pool.query("SELECT oral_video_parts, oral_video_key FROM submissions WHERE id = $1", [submissionId]);
    const row = r.rows[0];
    if (!row) return [];
    const parts = Array.isArray(row.oral_video_parts) ? row.oral_video_parts.filter(Boolean) : [];
    if (parts.length) return parts;
    return row.oral_video_key ? [row.oral_video_key] : [];
}
// Transcrição da prova oral (registro p/ avaliação). [{role,text}].
export async function setOralTranscript(submissionId, transcript) {
    await pool.query(
        "UPDATE submissions SET oral_transcript = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(transcript || []), submissionId]
    );
}
export async function getOralTranscript(submissionId) {
    const r = await pool.query("SELECT oral_transcript FROM submissions WHERE id = $1", [submissionId]);
    const t = r.rows[0]?.oral_transcript;
    return Array.isArray(t) ? t : [];
}
// --- Avaliação da prova oral (relatório de comparação ao gabarito) +
// devolutiva/nota MANUAIS do professor. Nota e publicação reusam as colunas da
// entrevista (grade_final, evaluation_published_at, grade_published_at). ---
export async function setOralEvaluation(submissionId, report) {
    await pool.query(
        "UPDATE submissions SET oral_eval_json = $1, evaluation_at = now(), updated_at = now() WHERE id = $2",
        [JSON.stringify(report || {}), submissionId]
    );
}
export async function setOralDevolutiva(submissionId, text) {
    const t = typeof text === "string" ? text : "";
    await pool.query(
        "UPDATE submissions SET oral_devolutiva = $1, updated_at = now() WHERE id = $2",
        [t, submissionId]
    );
}
export async function publishOralDevolutiva(submissionId, on) {
    await pool.query(
        `UPDATE submissions SET evaluation_published_at = ${on ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
        [submissionId]
    );
}
export async function publishOralGrade(submissionId, on) {
    await pool.query(
        `UPDATE submissions SET grade_published_at = ${on ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
        [submissionId]
    );
}
// Lote: submissões com transcrição (prova realizada) para avaliar. force=false
// pula as que já têm relatório; force=true reavalia todas.
export async function listOralSubmissionsForEval(workId, force = false) {
    const r = await pool.query(
        `SELECT id, submission_token, student_label
           FROM submissions
          WHERE work_id = $1 AND oral_transcript IS NOT NULL
            ${force ? "" : "AND oral_eval_json IS NULL"}
          ORDER BY created_at ASC`,
        [workId]
    );
    return r.rows;
}
// Lote: gerar devolutivas. Candidatas = provas já avaliadas (têm oral_eval_json).
// Sem force, pula quem já tem devolutiva escrita (preserva edição/geração anterior).
export async function listOralSubmissionsForDevolutiva(workId, force = false) {
    const r = await pool.query(
        `SELECT id, submission_token, student_label
           FROM submissions
          WHERE work_id = $1 AND oral_eval_json IS NOT NULL
            ${force ? "" : "AND (oral_devolutiva IS NULL OR oral_devolutiva = '')"}
          ORDER BY created_at ASC`,
        [workId]
    );
    return r.rows;
}
// Lote: publicar/despublicar devolutivas. Ao publicar, só afeta quem tem
// devolutiva escrita; ao despublicar, afeta todas as publicadas do trabalho.
export async function publishAllOralDevolutiva(workId, on) {
    const r = await pool.query(
        `UPDATE submissions
            SET evaluation_published_at = ${on ? "now()" : "NULL"}, updated_at = now()
          WHERE work_id = $1
            ${on ? "AND oral_devolutiva IS NOT NULL AND oral_devolutiva <> '' AND evaluation_published_at IS NULL"
                 : "AND evaluation_published_at IS NOT NULL"}`,
        [workId]
    );
    return r.rowCount;
}
// Lote: publicar/despublicar notas (mesma lógica das devolutivas).
export async function publishAllOralGrade(workId, on) {
    const r = await pool.query(
        `UPDATE submissions
            SET grade_published_at = ${on ? "now()" : "NULL"}, updated_at = now()
          WHERE work_id = $1
            ${on ? "AND grade_final IS NOT NULL AND grade_published_at IS NULL"
                 : "AND grade_published_at IS NOT NULL"}`,
        [workId]
    );
    return r.rowCount;
}
// Estado oral por aluno (painel do professor e visão do aluno).
export async function getOralSubmissionDetail(submissionId) {
    const r = await pool.query(
        `SELECT oral_eval_json, oral_devolutiva, oral_transcript, oral_proctor_json, oral_voice_json,
                oral_calibration_json,
                grade_final::float8 AS grade_final,
                evaluation_published_at, grade_published_at,
                (oral_video_key IS NOT NULL) AS has_oral_video,
                completion_reason, student_comment
         FROM submissions WHERE id = $1`,
        [submissionId]
    );
    return r.rows[0] || null;
}
// Resultado do proctoring local por vídeo (flags para revisão humana).
export async function setOralProctor(submissionId, report) {
    await pool.query(
        "UPDATE submissions SET oral_proctor_json = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(report || {}), submissionId]
    );
}
// Sinalizadores de voz. Mescla chaves no JSON existente (latência vem do relay;
// segunda voz / voz sintética vêm depois, da análise de áudio pós-prova).
export async function setOralVoice(submissionId, partial) {
    await pool.query(
        `UPDATE submissions SET oral_voice_json = COALESCE(oral_voice_json, '{}'::jsonb) || $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(partial || {}), submissionId]
    );
}

// Resultado do pré-teste de CALIBRAÇÃO DE FALA do aluno (registro p/ o professor).
// { passed, attempts, worst_wer, missed_terms, target, transcripts }. Ver migration 040.
export async function setOralCalibrationResult(submissionId, result) {
    await pool.query(
        "UPDATE submissions SET oral_calibration_json = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(result || {}), submissionId]
    );
}

// Marca a prova oral como concluída — idempotente (não sobrescreve se já estava).
// Usado para impedir refazer a prova (no-retake).
export async function markOralExamCompleted(submissionId) {
    await pool.query(
        `UPDATE submissions SET completion_reason = 'complete', completed_at = now(), updated_at = now()
         WHERE id = $1 AND completion_reason IS NULL`,
        [submissionId]
    );
}

// Lote de proctoring por vídeo: submissões com vídeo gravado. Sem force, pula
// as já analisadas; com force, reanalisa todas.
export async function listOralSubmissionsForProctor(workId, force = false) {
    const r = await pool.query(
        `SELECT id, submission_token, student_label
           FROM submissions
          WHERE work_id = $1 AND oral_video_key IS NOT NULL
            ${force ? "" : "AND oral_proctor_json IS NULL"}
          ORDER BY created_at ASC`,
        [workId]
    );
    return r.rows;
}

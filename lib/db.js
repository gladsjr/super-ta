// Data access layer for SuperTA. All filesystem-backed storage of works,
// submissions, interviewer templates and the conversation log lives here.
// Callers (server.js, lib/conversationLog.js, lib/middleware.js) speak in
// terms of these helpers and never touch SQL directly.

import { pool } from "../auth.js";
import crypto from "crypto";

// 12 hex chars = 6 random bytes. Same convention as the legacy filesystem
// layout used.
function newToken() {
    return crypto.randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------
// Status derivation (shared SQL fragment)
// ---------------------------------------------------------------------

const STATUS_EXPR = `
  CASE
    WHEN final_report_json IS NOT NULL THEN 'finalized'
    WHEN student_pdf IS NOT NULL OR conversation_json IS NOT NULL THEN 'in_progress'
    ELSE 'pending'
  END
`;

// ---------------------------------------------------------------------
// Works
// ---------------------------------------------------------------------

export async function listWorks() {
    const r = await pool.query(`
      SELECT
        w.work_token,
        w.name,
        w.enunciado_pdf IS NOT NULL AS assignment_pdf,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'pending'     THEN 1 ELSE 0 END), 0)::int AS pending,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'in_progress' THEN 1 ELSE 0 END), 0)::int AS in_progress,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'finalized'   THEN 1 ELSE 0 END), 0)::int AS finalized
      FROM works w
      LEFT JOIN submissions s ON s.work_id = w.id
      GROUP BY w.id
      ORDER BY w.created_at DESC, w.id DESC
    `);
    return r.rows;
}

export async function createWork(name) {
    const token = newToken();
    const r = await pool.query(
        "INSERT INTO works (work_token, name) VALUES ($1, $2) RETURNING work_token, name",
        [token, name]
    );
    return r.rows[0];
}

export async function getWorkByToken(workToken) {
    const r = await pool.query(`
      SELECT
        id,
        work_token,
        name,
        enunciado_pdf IS NOT NULL  AS has_enunciado,
        interviewer_yaml IS NOT NULL AS has_interviewer
      FROM works
      WHERE work_token = $1
    `, [workToken]);
    return r.rows[0] || null;
}

export async function getEnunciadoBlob(workId) {
    const r = await pool.query(
        "SELECT enunciado_pdf, enunciado_filename FROM works WHERE id = $1",
        [workId]
    );
    if (r.rowCount === 0 || !r.rows[0].enunciado_pdf) return null;
    return { pdf: r.rows[0].enunciado_pdf, filename: r.rows[0].enunciado_filename };
}

export async function setEnunciadoBlob(workId, buffer, filename) {
    await pool.query(
        "UPDATE works SET enunciado_pdf = $1, enunciado_filename = $2, updated_at = now() WHERE id = $3",
        [buffer, filename, workId]
    );
}

export async function getInterviewerYaml(workId) {
    const r = await pool.query(
        "SELECT interviewer_yaml FROM works WHERE id = $1",
        [workId]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].interviewer_yaml;
}

export async function setInterviewerYaml(workId, yamlText) {
    await pool.query(
        "UPDATE works SET interviewer_yaml = $1, updated_at = now() WHERE id = $2",
        [yamlText, workId]
    );
}

// ---------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------

export async function listSubmissionsForWork(workId) {
    const r = await pool.query(`
      SELECT
        submission_token,
        student_label,
        ${STATUS_EXPR} AS status
      FROM submissions
      WHERE work_id = $1
      ORDER BY created_at ASC, id ASC
    `, [workId]);
    return r.rows;
}

// Creates `count` submissions for a work, with labels derived from baseLabel
// (`baseLabel` if count=1, `baseLabel-i` otherwise — matches legacy behaviour).
export async function createSubmissions(workId, baseLabel, count) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        const submissionToken = newToken();
        const label = count > 1 ? `${baseLabel}-${i + 1}` : baseLabel;
        const r = await pool.query(
            `INSERT INTO submissions (submission_token, work_id, student_label)
             VALUES ($1, $2, $3)
             RETURNING submission_token, student_label`,
            [submissionToken, workId, label]
        );
        rows.push({ ...r.rows[0], status: "pending" });
    }
    return rows;
}

// Returns enough info for both /s/* and /w/:token/submissions/:sub/conversation
// in a single SELECT — work info plus the submission details.
export async function findSubmissionByToken(submissionToken) {
    const r = await pool.query(`
      SELECT
        s.id                                AS id,
        s.submission_token                  AS submission_token,
        s.student_label                     AS student_label,
        ${STATUS_EXPR}                      AS status,
        s.final_report_json                 AS final_report_json,
        w.id                                AS work_id,
        w.work_token                        AS work_token,
        w.name                              AS work_name,
        w.enunciado_pdf IS NOT NULL         AS work_enunciado_present,
        w.interviewer_yaml IS NOT NULL      AS work_interviewer_present
      FROM submissions s
      JOIN works w ON w.id = s.work_id
      WHERE s.submission_token = $1
    `, [submissionToken]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    let finalReport = null;
    if (row.status === "finalized" && row.final_report_json) {
        try { finalReport = JSON.parse(row.final_report_json); } catch { /* ignore */ }
    }
    return {
        id: row.id,
        submission_token: row.submission_token,
        student_label: row.student_label,
        status: row.status,
        final_report: finalReport,
        work_id: row.work_id,
        work_token: row.work_token,
        work_name: row.work_name,
        work_enunciado_present: row.work_enunciado_present,
        work_interviewer_present: row.work_interviewer_present,
    };
}

export async function setStudentPdf(submissionId, buffer, filename) {
    await pool.query(
        "UPDATE submissions SET student_pdf = $1, student_pdf_filename = $2, updated_at = now() WHERE id = $3",
        [buffer, filename, submissionId]
    );
}

export async function getStudentPdfBlob(submissionId) {
    const r = await pool.query(
        "SELECT student_pdf, student_pdf_filename FROM submissions WHERE id = $1",
        [submissionId]
    );
    if (r.rowCount === 0 || !r.rows[0].student_pdf) return null;
    return { pdf: r.rows[0].student_pdf, filename: r.rows[0].student_pdf_filename };
}

export async function getConversationJson(submissionId) {
    const r = await pool.query(
        "SELECT conversation_json FROM submissions WHERE id = $1",
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].conversation_json;
}

export async function setConversationJson(submissionId, jsonText) {
    await pool.query(
        "UPDATE submissions SET conversation_json = $1, updated_at = now() WHERE id = $2",
        [jsonText, submissionId]
    );
}

export async function setFinalReport(submissionId, jsonText) {
    await pool.query(
        "UPDATE submissions SET final_report_json = $1, updated_at = now() WHERE id = $2",
        [jsonText, submissionId]
    );
}

// ---------------------------------------------------------------------
// Interviewer templates (shared, replaces config/interviewers/*.yaml)
// ---------------------------------------------------------------------

export async function listInterviewerTemplates() {
    const r = await pool.query(
        "SELECT filename FROM interviewer_templates ORDER BY filename ASC"
    );
    return r.rows.map(row => ({ filename: row.filename }));
}

export async function getInterviewerTemplate(filename) {
    const r = await pool.query(
        "SELECT yaml_text FROM interviewer_templates WHERE filename = $1",
        [filename]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].yaml_text;
}

export async function upsertInterviewerTemplate(filename, yamlText) {
    await pool.query(`
      INSERT INTO interviewer_templates (filename, yaml_text)
      VALUES ($1, $2)
      ON CONFLICT (filename) DO UPDATE
        SET yaml_text = EXCLUDED.yaml_text, updated_at = now()
    `, [filename, yamlText]);
}

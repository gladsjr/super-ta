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
        w.id,
        w.work_token,
        w.name,
        w.enunciado_pdf IS NOT NULL AS assignment_pdf,
        w.budget_usd::float8 AS budget_usd,
        w.spent_usd::float8  AS spent_usd,
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

export async function createWork(name, budgetUsd) {
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
        throw new Error("createWork: budgetUsd must be a non-negative finite number");
    }
    const token = newToken();
    const r = await pool.query(
        `INSERT INTO works (work_token, name, budget_usd)
         VALUES ($1, $2, $3)
         RETURNING id, work_token, name, budget_usd::float8 AS budget_usd, spent_usd::float8 AS spent_usd`,
        [token, name, budgetUsd]
    );
    return r.rows[0];
}

export async function updateWorkBudget(workId, budgetUsd) {
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
        throw new Error("updateWorkBudget: budgetUsd must be a non-negative finite number");
    }
    const r = await pool.query(
        `UPDATE works SET budget_usd = $1, updated_at = now() WHERE id = $2
         RETURNING budget_usd::float8 AS budget_usd, spent_usd::float8 AS spent_usd`,
        [budgetUsd, workId]
    );
    return r.rows[0] || null;
}

export async function getWorkByToken(workToken) {
    const r = await pool.query(`
      SELECT
        id,
        work_token,
        name,
        enunciado_pdf IS NOT NULL  AS has_enunciado,
        interviewer_yaml IS NOT NULL AS has_interviewer,
        interaction_mode,
        voice,
        budget_usd::float8 AS budget_usd,
        spent_usd::float8  AS spent_usd
      FROM works
      WHERE work_token = $1
    `, [workToken]);
    return r.rows[0] || null;
}

export async function listCostEventsForWork(workId, limit = 50) {
    const r = await pool.query(
        `SELECT id, submission_id, event_type, model, agent_label,
                input_tokens, cached_tokens, output_tokens,
                audio_seconds, audio_chars,
                cost_usd::float8 AS cost_usd, created_at
         FROM work_cost_events
         WHERE work_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [workId, limit]
    );
    return r.rows;
}

export async function setInteractionMode(workId, mode, voice) {
    if (mode !== "text" && mode !== "audio") {
        throw new Error(`invalid interaction_mode "${mode}"`);
    }
    const voiceParam = mode === "audio" ? voice : null;
    await pool.query(
        "UPDATE works SET interaction_mode = $1, voice = $2, updated_at = now() WHERE id = $3",
        [mode, voiceParam, workId]
    );
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
// Enunciado coherence cache
// Cached output of EnunciadoCoherenceAgent. Reset whenever the enunciado PDF
// is replaced (handled in setEnunciadoBlob caller).
// ---------------------------------------------------------------------

export async function getCoherenceCache(workId) {
    const r = await pool.query(
        "SELECT enunciado_coherence_json FROM works WHERE id = $1",
        [workId]
    );
    if (r.rowCount === 0) return null;
    const text = r.rows[0].enunciado_coherence_json;
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { return null; }
}

export async function setCoherenceCache(workId, reportObject) {
    await pool.query(
        "UPDATE works SET enunciado_coherence_json = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(reportObject), workId]
    );
}

export async function clearCoherenceCache(workId) {
    await pool.query(
        "UPDATE works SET enunciado_coherence_json = NULL, updated_at = now() WHERE id = $1",
        [workId]
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
        w.interviewer_yaml IS NOT NULL      AS work_interviewer_present,
        w.interaction_mode                  AS work_interaction_mode,
        w.voice                             AS work_voice,
        w.budget_usd::float8                AS work_budget_usd,
        w.spent_usd::float8                 AS work_spent_usd
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
        work_interaction_mode: row.work_interaction_mode,
        work_voice: row.work_voice,
        work_budget_usd: row.work_budget_usd,
        work_spent_usd: row.work_spent_usd,
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

// Boolean barato: evita trazer o bytea (até ~MB) quando só precisamos saber
// se já houve upload (ex.: /start). Devolve true só se a coluna está preenchida.
export async function hasStudentPdf(submissionId) {
    const r = await pool.query(
        "SELECT (student_pdf IS NOT NULL) AS present FROM submissions WHERE id = $1",
        [submissionId]
    );
    return r.rowCount > 0 && r.rows[0].present === true;
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
// Runtime state (persistência da entrevista em andamento)
// Ver migration 004 e lib/sessionState.js.
// runtime_state_json IS NULL ⇔ "sem tentativa em andamento" (também é o
// estado pós-/finalize, deixando conversation_json e final_report intactos).
// ---------------------------------------------------------------------

export async function getSubmissionRuntimeState(submissionId) {
    const r = await pool.query(
        `SELECT current_phase, question_index,
                frozen_interaction_mode, frozen_voice,
                runtime_state_json
         FROM submissions
         WHERE id = $1`,
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    if (row.runtime_state_json == null && row.current_phase == null) return null;
    return {
        current_phase: row.current_phase,
        question_index: row.question_index,
        frozen_interaction_mode: row.frozen_interaction_mode,
        frozen_voice: row.frozen_voice,
        // node-postgres já parseia JSONB para objeto; mas se vier string fallback parse.
        runtime_state: typeof row.runtime_state_json === "string"
            ? JSON.parse(row.runtime_state_json)
            : row.runtime_state_json,
    };
}

// UPDATE atômico: conversation_json + cinco colunas de runtime, num único
// statement. Usado pelo hot-path do /chat handler (a cada turno) e pelo
// /upload (após a saudação).
export async function persistSubmissionState(submissionId, {
    conversationJsonText,
    currentPhase,
    questionIndex,
    frozenInteractionMode,
    frozenVoice,
    runtimeState,
}) {
    await pool.query(
        `UPDATE submissions
         SET conversation_json       = $1,
             current_phase           = $2,
             question_index          = $3,
             frozen_interaction_mode = $4,
             frozen_voice            = $5,
             runtime_state_json      = $6,
             updated_at              = now()
         WHERE id = $7`,
        [
            conversationJsonText,
            currentPhase,
            questionIndex,
            frozenInteractionMode,
            frozenVoice,
            runtimeState != null ? JSON.stringify(runtimeState) : null,
            submissionId,
        ]
    );
}

// Pós-/finalize: zera runtime mas preserva conversation_json e final_report_json.
export async function clearSubmissionRuntimeState(submissionId) {
    await pool.query(
        `UPDATE submissions
         SET current_phase           = NULL,
             question_index          = NULL,
             frozen_interaction_mode = NULL,
             frozen_voice            = NULL,
             runtime_state_json      = NULL,
             updated_at              = now()
         WHERE id = $1`,
        [submissionId]
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

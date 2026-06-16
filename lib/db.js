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

// Ordem importa: finalização (completion_reason) vence o estado derivado dos
// blobs. Valores de completion_reason: 'complete' | 'give_up' (ver
// finalizeSubmission). 'gave_up'/'completed' são os rótulos derivados.
const STATUS_EXPR = `
  CASE
    WHEN completion_reason = 'give_up' THEN 'gave_up'
    WHEN completion_reason IS NOT NULL THEN 'completed'
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
        w.is_active,
        w.enunciado_pdf IS NOT NULL AS assignment_pdf,
        w.budget_usd::float8 AS budget_usd,
        w.spent_usd::float8  AS spent_usd,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'pending'     THEN 1 ELSE 0 END), 0)::int AS pending,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'in_progress' THEN 1 ELSE 0 END), 0)::int AS in_progress,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'completed'   THEN 1 ELSE 0 END), 0)::int AS completed,
        COALESCE(SUM(CASE WHEN ${STATUS_EXPR} = 'gave_up'     THEN 1 ELSE 0 END), 0)::int AS gave_up
      FROM works w
      LEFT JOIN submissions s ON s.work_id = w.id
      GROUP BY w.id
      ORDER BY w.created_at DESC, w.id DESC
    `);
    return r.rows;
}

export async function setWorkActive(workId, isActive) {
    const r = await pool.query(
        `UPDATE works
         SET is_active = $1, updated_at = now()
         WHERE id = $2
         RETURNING is_active`,
        [!!isActive, workId]
    );
    return r.rowCount > 0 ? r.rows[0].is_active : null;
}

// Apaga o trabalho e tudo encadeado: submissions e work_cost_events caem por
// ON DELETE CASCADE (ver migrations 001 e 003). Operação irreversível — a UI
// deve confirmar antes.
export async function deleteWork(workId) {
    const r = await pool.query("DELETE FROM works WHERE id = $1", [workId]);
    return r.rowCount > 0;
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

export async function renameWork(workId, newName) {
    const name = String(newName ?? "").trim();
    if (!name) throw new Error("renameWork: name required");
    await pool.query(
        "UPDATE works SET name = $1, updated_at = now() WHERE id = $2",
        [name, workId]
    );
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
        question_count,
        interviewer_name,
        interviewer_gender,
        feedback_guidelines,
        include_interviewer_opinion,
        include_strengths,
        include_improvement_areas,
        include_study_suggestions,
        grading_rubric,
        expect_spontaneous,
        budget_usd::float8 AS budget_usd,
        spent_usd::float8  AS spent_usd
      FROM works
      WHERE work_token = $1
    `, [workToken]);
    return r.rows[0] || null;
}

// Configurações de devolutiva do trabalho: diretrizes + defaults de
// visibilidade das seções (incluindo a opinião do entrevistador). Valem para
// os lotes; ajuste por aluno fica na submissão. `sections` aceita qualquer
// subconjunto das chaves de FEEDBACK_SECTIONS → boolean.
export async function setWorkFeedbackSettings(workId, guidelines, sections = {}) {
    const trimmed = typeof guidelines === "string" && guidelines.trim() ? guidelines.trim() : null;
    const sets = ["feedback_guidelines = $1"];
    const vals = [trimmed];
    appendSectionSets(sets, vals, sections);
    vals.push(workId);
    await pool.query(
        `UPDATE works SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`,
        vals
    );
    return { feedback_guidelines: trimmed };
}

// Identidade do entrevistador (nome + gênero). Aceita os dois preenchidos
// (override do sorteio aleatório no /upload) ou os dois nulos (volta ao
// comportamento padrão). XOR é rejeitado tanto aqui quanto pela CHECK
// constraint no banco (migration 007).
export async function setWorkExpectSpontaneous(workId, expect) {
    await pool.query(
        "UPDATE works SET expect_spontaneous = $1, updated_at = now() WHERE id = $2",
        [!!expect, workId]
    );
}

// Rubrica de notas do trabalho. `criteria` é um array [{id,name,weight,prompt}]
// já validado pela rota (validateRubricShape em lib/rubric.js). Armazenado como
// { criteria } serializado em grading_rubric (TEXT). NULL volta ao DEFAULT_RUBRIC.
export async function setWorkRubric(workId, criteria) {
    await pool.query(
        "UPDATE works SET grading_rubric = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify({ criteria }), workId]
    );
}

export async function setWorkInterviewerIdentity(workId, name, gender) {
    const bothNull = name == null && gender == null;
    const bothSet = typeof name === "string" && name.trim() && (gender === "f" || gender === "m");
    if (!bothNull && !bothSet) {
        throw new Error("setWorkInterviewerIdentity: name e gender devem ser ambos preenchidos ou ambos nulos");
    }
    await pool.query(
        "UPDATE works SET interviewer_name = $1, interviewer_gender = $2, updated_at = now() WHERE id = $3",
        [bothNull ? null : name.trim(), bothNull ? null : gender, workId]
    );
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

// Número de perguntas planejadas. Guard inline (defesa) espelha a faixa de
// config.js#isValidQuestionCount e a CHECK constraint da migration 010. A rota
// já valida antes; aqui é a última barreira antes do banco.
export async function setQuestionCount(workId, count) {
    if (!Number.isInteger(count) || count < 3 || count > 20) {
        throw new Error(`invalid question_count "${count}"`);
    }
    await pool.query(
        "UPDATE works SET question_count = $1, updated_at = now() WHERE id = $2",
        [count, workId]
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
        is_blocked,
        is_test,
        completion_reason,
        completed_at,
        evaluation_at,
        (evaluation_json IS NOT NULL) AS has_evaluation,
        (student_evaluation_json IS NOT NULL OR student_evaluation_edited_json IS NOT NULL) AS has_student_version,
        evaluation_published_at,
        (grades_json IS NOT NULL) AS has_grades,
        grade_final::float8 AS grade_final,
        grade_published_at,
        ${STATUS_EXPR} AS status
      FROM submissions
      WHERE work_id = $1
      ORDER BY created_at ASC, id ASC
    `, [workId]);
    return r.rows;
}

// Marca a submission como finalizada. Operação atômica: define os três campos
// (completion_reason, completed_at, student_comment) numa única UPDATE. É
// idempotente — chamar duas vezes não faz mal, só sobrescreve com o mesmo
// valor. A imutabilidade pós-finalize é garantida por checagens nos handlers
// de /chat, /upload e /audio (devolvem 410 se completion_reason IS NOT NULL).
export async function finalizeSubmission(submissionId, comment, reason) {
    if (reason !== "complete" && reason !== "give_up") {
        throw new Error(`finalizeSubmission: reason inválida (${reason})`);
    }
    const trimmed = typeof comment === "string" ? comment.trim() : null;
    const finalComment = trimmed && trimmed.length > 0 ? trimmed : null;
    await pool.query(
        `UPDATE submissions
         SET completion_reason = $1,
             completed_at = now(),
             student_comment = $2,
             updated_at = now()
         WHERE id = $3`,
        [reason, finalComment, submissionId]
    );
}

// Atualiza só o student_comment (independente de finalizeSubmission).
// Usado pelo POST /s/:t/comment depois da revisão pós-entrevista.
// Caller é responsável por garantir que comment != null e que não houve
// student_comment antes (single-shot — endpoint checa antes de chamar).
export async function setSubmissionStudentComment(submissionId, comment) {
    await pool.query(
        `UPDATE submissions
         SET student_comment = $1,
             updated_at = now()
         WHERE id = $2`,
        [comment, submissionId]
    );
}

export async function getSubmissionFinalization(submissionId) {
    const r = await pool.query(
        `SELECT completion_reason, completed_at, student_comment
         FROM submissions
         WHERE id = $1`,
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0];
}

// Cria uma submission por label fornecido. Aceita duplicatas — o token gerado
// é o identificador único; rótulos repetidos são problema do professor (ele
// pode colar o mesmo nome duas vezes intencionalmente ou não), não do banco.
// Caller é responsável por sanitizar cada label (lib/middleware.js#sanitizeLabel).
export async function createSubmissionsFromLabels(workId, labels, isTest = false) {
    const rows = [];
    for (const label of labels) {
        const submissionToken = newToken();
        const r = await pool.query(
            `INSERT INTO submissions (submission_token, work_id, student_label, is_test)
             VALUES ($1, $2, $3, $4)
             RETURNING submission_token, student_label, is_test`,
            [submissionToken, workId, label, !!isTest]
        );
        rows.push({ ...r.rows[0], status: "pending", is_blocked: false });
    }
    return rows;
}

// Atalho legado: `count` submissions com labels derivados de baseLabel
// (`baseLabel` se count=1, `baseLabel-i` caso contrário). Mantido porque a UI
// ainda oferece o modo "rótulo único + quantidade".
export async function createSubmissions(workId, baseLabel, count, isTest = false) {
    const labels = [];
    for (let i = 0; i < count; i++) {
        labels.push(count > 1 ? `${baseLabel}-${i + 1}` : baseLabel);
    }
    return createSubmissionsFromLabels(workId, labels, isTest);
}

export async function setSubmissionBlocked(submissionId, isBlocked) {
    const r = await pool.query(
        `UPDATE submissions
         SET is_blocked = $1, updated_at = now()
         WHERE id = $2
         RETURNING is_blocked`,
        [!!isBlocked, submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].is_blocked : null;
}

// Returns enough info for both /s/* and /w/:token/submissions/:sub/conversation
// in a single SELECT — work info plus the submission details.
export async function findSubmissionByToken(submissionToken) {
    const r = await pool.query(`
      SELECT
        s.id                                AS id,
        s.submission_token                  AS submission_token,
        s.student_label                     AS student_label,
        s.is_blocked                        AS is_blocked,
        s.completion_reason                 AS completion_reason,
        s.completed_at                      AS completed_at,
        s.student_comment                   AS student_comment,
        s.is_test                           AS is_test,
        ${STATUS_EXPR}                      AS status,
        w.id                                AS work_id,
        w.work_token                        AS work_token,
        w.name                              AS work_name,
        w.is_active                         AS work_is_active,
        w.enunciado_pdf IS NOT NULL         AS work_enunciado_present,
        w.interviewer_yaml IS NOT NULL      AS work_interviewer_present,
        w.interaction_mode                  AS work_interaction_mode,
        w.voice                             AS work_voice,
        w.question_count                    AS work_question_count,
        w.interviewer_name                  AS work_interviewer_name,
        w.interviewer_gender                AS work_interviewer_gender,
        w.expect_spontaneous                AS work_expect_spontaneous,
        w.budget_usd::float8                AS work_budget_usd,
        w.spent_usd::float8                 AS work_spent_usd
      FROM submissions s
      JOIN works w ON w.id = s.work_id
      WHERE s.submission_token = $1
    `, [submissionToken]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
        id: row.id,
        submission_token: row.submission_token,
        student_label: row.student_label,
        is_blocked: !!row.is_blocked,
        completion_reason: row.completion_reason,
        completed_at: row.completed_at,
        student_comment: row.student_comment,
        is_test: !!row.is_test,
        status: row.status,
        work_id: row.work_id,
        work_token: row.work_token,
        work_name: row.work_name,
        work_is_active: row.work_is_active !== false,
        work_enunciado_present: row.work_enunciado_present,
        work_interviewer_present: row.work_interviewer_present,
        work_interaction_mode: row.work_interaction_mode,
        work_voice: row.work_voice,
        work_question_count: row.work_question_count,
        work_interviewer_name: row.work_interviewer_name,
        work_interviewer_gender: row.work_interviewer_gender,
        work_expect_spontaneous: row.work_expect_spontaneous === true,
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

// ---------------------------------------------------------------------
// Interview evaluation cache
// Cached output of InterviewEvaluatorAgent (avaliação da entrevista sob a
// perspectiva do entrevistador). Regenerável via ?force=true na rota.
// ---------------------------------------------------------------------

export async function getEvaluationCache(submissionId) {
    const r = await pool.query(
        "SELECT evaluation_json, evaluation_at FROM submissions WHERE id = $1",
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    const text = r.rows[0].evaluation_json;
    if (!text) return null;
    try {
        return { report: JSON.parse(text), evaluated_at: r.rows[0].evaluation_at };
    } catch {
        return null;
    }
}

export async function setEvaluationCache(submissionId, reportObject) {
    const r = await pool.query(
        `UPDATE submissions
         SET evaluation_json = $1, evaluation_at = now(), updated_at = now()
         WHERE id = $2
         RETURNING evaluation_at`,
        [JSON.stringify(reportObject), submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].evaluation_at : null;
}

// ---------------------------------------------------------------------
// Notas por rubrica (GradingAgent)
// gradesObj: { criteria:[{id,name,weight,score,justification,manual}], final }.
// grade_final é desnormalizado para listagem/ordenação.
// ---------------------------------------------------------------------
export async function getSubmissionGrades(submissionId) {
    const r = await pool.query(
        "SELECT grades_json, grade_final::float8 AS grade_final, grades_at, grade_published_at FROM submissions WHERE id = $1",
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    const text = r.rows[0].grades_json;
    if (!text) return null;
    try {
        return { ...JSON.parse(text), final: r.rows[0].grade_final, computed_at: r.rows[0].grades_at, published_at: r.rows[0].grade_published_at };
    } catch {
        return null;
    }
}

export async function setSubmissionGrades(submissionId, gradesObj) {
    const final = typeof gradesObj?.final === "number" ? gradesObj.final : null;
    const r = await pool.query(
        `UPDATE submissions
         SET grades_json = $1, grade_final = $2, grades_at = now(), updated_at = now()
         WHERE id = $3
         RETURNING grades_at`,
        [JSON.stringify(gradesObj), final, submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].grades_at : null;
}

// Publica/despublica a NOTA (independente da devolutiva). grade_published_at
// NULL = aluno não vê a nota; preenchido = visível.
export async function setGradePublished(submissionId, published) {
    const r = await pool.query(
        `UPDATE submissions
         SET grade_published_at = ${published ? "now()" : "NULL"}, updated_at = now()
         WHERE id = $1
         RETURNING grade_published_at`,
        [submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].grade_published_at : null;
}

// A nota como o ALUNO a vê, quando publicada: nota final + critérios
// (nome/peso/nota), SEM justificativas (podem conter linguagem forense — ficam
// internas). Retorna null se não há nota ou se não está publicada.
export async function getPublishedStudentGrade(submissionId) {
    const r = await pool.query(
        "SELECT grades_json, grade_final::float8 AS grade_final, grade_published_at FROM submissions WHERE id = $1",
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    if (!row.grade_published_at || !row.grades_json || typeof row.grade_final !== "number") return null;
    let parsed;
    try { parsed = JSON.parse(row.grades_json); } catch { return null; }
    return {
        published_at: row.grade_published_at,
        grade: {
            final: row.grade_final,
            criteria: (Array.isArray(parsed.criteria) ? parsed.criteria : []).map(c => ({ name: c.name, weight: c.weight, score: c.score })),
        },
    };
}

// ---------------------------------------------------------------------
// Devolutiva publicada ao aluno (StudentFeedbackAgent)
// Versão formativa derivada da avaliação interna. evaluation_published_at
// NULL = invisível ao aluno; preenchido = publicada (a versão pode existir
// despublicada, ex.: prévia gerada e depois retirada do ar).
// ---------------------------------------------------------------------

// Seções da devolutiva e a coluna de visibilidade correspondente na submission
// (e o default no work). interviewer_opinion é especial: o conteúdo NÃO vive
// na versão do aluno — é a interviewer_impression do relatório interno.
export const FEEDBACK_SECTIONS = [
    { key: "interviewer_opinion", column: "include_interviewer_opinion", field: null },
    { key: "strengths", column: "include_strengths", field: "strengths" },
    { key: "improvement_areas", column: "include_improvement_areas", field: "improvement_areas" },
    { key: "study_suggestions", column: "include_study_suggestions", field: "study_suggestions" },
];

// Acrescenta a `sets`/`vals` os pares "coluna = $N" para cada seção de
// FEEDBACK_SECTIONS presente (boolean) em `sections`. Muta os arrays. Fonte
// única do mapeamento seção→coluna usada por setWorkFeedbackSettings e
// setSubmissionSections (antes duplicado nos dois).
function appendSectionSets(sets, vals, sections) {
    for (const s of FEEDBACK_SECTIONS) {
        if (typeof sections?.[s.key] === "boolean") {
            vals.push(sections[s.key]);
            sets.push(`${s.column} = $${vals.length}`);
        }
    }
}

// Devolve as DUAS camadas (automática + editada), a BASE (efetiva sem aplicar
// visibilidade — para o editor) e a EFETIVA (`report`, o que o aluno vê / se
// publica). A efetiva = base (editada ?? automática) menos as seções
// desligadas; a OPINIÃO DO ENTREVISTADOR é a interviewer_impression do
// relatório INTERNO, injetada quando ligada (não editável). Retorna null se
// nenhuma versão existe.
export async function getStudentEvaluation(submissionId) {
    const r = await pool.query(
        `SELECT student_evaluation_json, student_evaluation_at,
                student_evaluation_edited_json, student_evaluation_edited_at,
                evaluation_published_at, evaluation_json,
                include_interviewer_opinion, include_strengths,
                include_improvement_areas, include_study_suggestions
         FROM submissions WHERE id = $1`,
        [submissionId]
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    const parse = text => {
        if (!text) return null;
        try { return JSON.parse(text); } catch { return null; }
    };
    const auto = parse(row.student_evaluation_json);
    const edited = parse(row.student_evaluation_edited_json);
    if (!auto && !edited) return null;
    const internal = parse(row.evaluation_json);
    const opinion = typeof internal?.interviewer_impression === "string" && internal.interviewer_impression.trim()
        ? internal.interviewer_impression
        : null;
    // NOTA: não vive mais aqui. A nota é um artefato publicável próprio (gated
    // por grade_published_at) — ver getPublishedStudentGrade. A devolutiva
    // (subjetiva) é independente dela.

    const base = { ...(edited ?? auto) };
    delete base.interviewer_opinion; // a opinião nunca vive na base editável

    // Flags de visibilidade (default ligado) e presença de conteúdo por seção.
    const sections = {};
    const sectionHas = {};
    for (const s of FEEDBACK_SECTIONS) {
        sections[s.key] = row[s.column] !== false;
        if (s.key === "interviewer_opinion") sectionHas[s.key] = !!opinion;
        else sectionHas[s.key] = Array.isArray(base[s.field]) && base[s.field].length > 0;
    }

    // Efetiva: base sem as seções desligadas + opinião injetada se ligada.
    const report = { ...base };
    for (const s of FEEDBACK_SECTIONS) {
        if (s.field && !sections[s.key]) delete report[s.field];
    }
    if (sections.interviewer_opinion && opinion) report.interviewer_opinion = opinion;

    return {
        report,
        base_report: base,
        auto_report: auto,
        generated_at: row.student_evaluation_at,
        edited_report: edited,
        edited_at: row.student_evaluation_edited_at,
        published_at: row.evaluation_published_at,
        sections,
        section_has: sectionHas,
        // compat com consumidores anteriores
        include_interviewer_opinion: sections.interviewer_opinion,
        has_interviewer_opinion: !!opinion,
    };
}

// Atualiza a visibilidade de seções de UMA submissão. `partial` aceita
// qualquer subconjunto das chaves de FEEDBACK_SECTIONS → boolean.
export async function setSubmissionSections(submissionId, partial) {
    const sets = [];
    const vals = [];
    appendSectionSets(sets, vals, partial);
    if (sets.length === 0) return;
    vals.push(submissionId);
    await pool.query(
        `UPDATE submissions SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`,
        vals
    );
}

// Visibilidade de seções da submissão (as flags include_*), independente de
// existir devolutiva. Default ligado. Usado na geração para o agente saber
// quais blocos serão exibidos e quais dobrar no summary.
export async function getSubmissionSections(submissionId) {
    const cols = FEEDBACK_SECTIONS.map(s => s.column).join(", ");
    const r = await pool.query(`SELECT ${cols} FROM submissions WHERE id = $1`, [submissionId]);
    const out = {};
    const row = r.rows[0] || {};
    for (const s of FEEDBACK_SECTIONS) out[s.key] = row[s.column] !== false;
    return out;
}

// Propaga os defaults de seção do work para TODAS as submissões dele (usado
// pelo "aplicar a todos" e pelos lotes). Operação barata, sem LLM.
export async function applyWorkSectionsToAllSubmissions(workId) {
    // Copia cada coluna de visibilidade do work para a submissão. Derivado de
    // FEEDBACK_SECTIONS (antes era uma 3ª cópia hardcoded da lista de colunas).
    const sets = FEEDBACK_SECTIONS.map(s => `${s.column} = w.${s.column}`).join(",\n            ");
    await pool.query(
        `UPDATE submissions s SET
            ${sets},
            updated_at = now()
         FROM works w
         WHERE s.work_id = w.id AND w.id = $1`,
        [workId]
    );
}

export async function setStudentEvaluation(submissionId, reportObject) {
    const r = await pool.query(
        `UPDATE submissions
         SET student_evaluation_json = $1, student_evaluation_at = now(), updated_at = now()
         WHERE id = $2
         RETURNING student_evaluation_at`,
        [JSON.stringify(reportObject), submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].student_evaluation_at : null;
}

// Salva (ou limpa, com null) a versão EDITADA pelo professor. A automática
// não é tocada — "restaurar automática" = setStudentEvaluationEdited(id, null).
export async function setStudentEvaluationEdited(submissionId, reportObjectOrNull) {
    const r = await pool.query(
        `UPDATE submissions
         SET student_evaluation_edited_json = $1,
             student_evaluation_edited_at = ${reportObjectOrNull ? "now()" : "NULL"},
             updated_at = now()
         WHERE id = $2
         RETURNING student_evaluation_edited_at`,
        [reportObjectOrNull ? JSON.stringify(reportObjectOrNull) : null, submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].student_evaluation_edited_at : null;
}

export async function setEvaluationPublished(submissionId, published) {
    const r = await pool.query(
        `UPDATE submissions
         SET evaluation_published_at = ${published ? "now()" : "NULL"}, updated_at = now()
         WHERE id = $1
         RETURNING evaluation_published_at`,
        [submissionId]
    );
    return r.rowCount > 0 ? r.rows[0].evaluation_published_at : null;
}

// ---------------------------------------------------------------------
// Runtime state (persistência da entrevista em andamento)
// Ver migration 004 e lib/sessionState.js.
// runtime_state_json IS NULL ⇔ "sem tentativa em andamento".
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

// Limpa o estado de runtime ao finalizar a entrevista, restaurando o invariante
// "runtime_state_json IS NULL ⇔ sem tentativa em andamento". Chamado pelo handler
// de /chat logo após persistFinalization (finalize do orquestrador ou cap de
// turnos). O completion_reason/conversation_json continuam intactos; só o estado
// de retomada é zerado. current_phase volta a NULL — é o sentinela canônico de
// "sem tentativa em andamento" (mesmo par NULL/NULL que getSubmissionRuntimeState
// trata como ausência de runtime). NÃO usar "finalized": a CHECK constraint
// submissions_current_phase_chk só aceita NULL/awaiting_upload/intro/interviewing/
// finalizing, e a finalização já está registrada em completion_reason/completed_at.
export async function clearSubmissionRuntimeState(submissionId) {
    await pool.query(
        `UPDATE submissions
         SET runtime_state_json = NULL,
             current_phase      = NULL,
             updated_at         = now()
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

// Versão do consentimento aceito por uma submission. Útil pra detectar
// gravações capturadas sob termo antigo (sem cláusula de retenção).
export async function setSubmissionConsentVersion(submissionId, version) {
    await pool.query(
        `UPDATE submissions SET consent_version = $1, updated_at = now() WHERE id = $2`,
        [version, submissionId]
    );
}

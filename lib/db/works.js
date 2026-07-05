// Trabalhos/config (works). Parte do split de lib/db.js (ver lib/db.js, que é o
// barrel que re-exporta tudo). SQL e lógica preservados verbatim do módulo
// monolítico original.

import { pool } from "../../auth.js";
import { newToken, STATUS_EXPR, appendSectionSets } from "./_shared.js";

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
        w.kind,
        w.enunciado_pdf IS NOT NULL AS assignment_pdf,
        w.budget_usd::float8 AS budget_usd,
        w.spent_usd::float8  AS spent_usd,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'pending'     THEN 1 ELSE 0 END), 0)::int AS pending,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'in_progress' THEN 1 ELSE 0 END), 0)::int AS in_progress,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'completed'   THEN 1 ELSE 0 END), 0)::int AS completed,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'gave_up'     THEN 1 ELSE 0 END), 0)::int AS gave_up
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

export async function createWork(name, budgetUsd, kind = "interview") {
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
        throw new Error("createWork: budgetUsd must be a non-negative finite number");
    }
    if (kind !== "interview" && kind !== "oral_realtime" && kind !== "scenario") {
        throw new Error(`createWork: invalid kind "${kind}"`);
    }
    const token = newToken();
    const r = await pool.query(
        `INSERT INTO works (work_token, name, budget_usd, kind)
         VALUES ($1, $2, $3, $4)
         RETURNING id, work_token, name, kind, budget_usd::float8 AS budget_usd, spent_usd::float8 AS spent_usd`,
        [token, name, budgetUsd, kind]
    );
    return r.rows[0];
}

// --- Prova oral (Realtime) ---

// PDF da prova (perguntas e respostas) que o professor sobe.
export async function setExamPdf(workId, buffer, filename) {
    await pool.query(
        "UPDATE works SET exam_pdf = $1, exam_filename = $2, updated_at = now() WHERE id = $3",
        [buffer, filename, workId]
    );
}
export async function getExamBlob(workId) {
    const r = await pool.query("SELECT exam_pdf, exam_filename FROM works WHERE id = $1", [workId]);
    if (r.rowCount === 0 || !r.rows[0].exam_pdf) return null;
    return { pdf: r.rows[0].exam_pdf, filename: r.rows[0].exam_filename };
}
// Perguntas extraídas (JSONB [{id,question,answer}]). As respostas ficam aqui;
// nunca vão à sessão Realtime do aluno.
export async function setOralQuestions(workId, questions) {
    await pool.query(
        "UPDATE works SET oral_questions = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(questions || []), workId]
    );
}
export async function getOralQuestions(workId) {
    const r = await pool.query("SELECT oral_questions FROM works WHERE id = $1", [workId]);
    const q = r.rows[0]?.oral_questions;
    return Array.isArray(q) ? q : [];
}
// Modo de pontuação da prova oral ('deterministico' | 'rubrica'). Ver migration 036.
export async function getOralGradingMode(workId) {
    const r = await pool.query("SELECT oral_grading_mode FROM works WHERE id = $1", [workId]);
    return r.rows[0]?.oral_grading_mode === "rubrica" ? "rubrica" : "deterministico";
}
export async function setOralGradingMode(workId, mode) {
    const m = mode === "rubrica" ? "rubrica" : "deterministico";
    await pool.query("UPDATE works SET oral_grading_mode = $1, updated_at = now() WHERE id = $2", [m, workId]);
    return m;
}
// Voz do examinador (prova oral) — sem tocar em interaction_mode.
export async function setWorkVoice(workId, voice) {
    await pool.query(
        "UPDATE works SET voice = $1, updated_at = now() WHERE id = $2",
        [voice || null, workId]
    );
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
        kind,
        exam_pdf IS NOT NULL AS has_exam,
        COALESCE(jsonb_array_length(oral_questions), 0) AS oral_question_count,
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

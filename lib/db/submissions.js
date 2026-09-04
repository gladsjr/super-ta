// Submissões + avaliação/devolutiva/notas/feedback. Parte do split de lib/db.js
// (ver lib/db.js, que é o barrel que re-exporta tudo). SQL e lógica preservados
// verbatim do módulo monolítico original.

import { pool } from "../../auth.js";
import { newToken, STATUS_EXPR, FEEDBACK_SECTIONS, appendSectionSets } from "./_shared.js";

// FEEDBACK_SECTIONS é export pública (definida em _shared.js junto de
// appendSectionSets, que works.js também consome). Re-exporta aqui para manter
// o nome acessível pelo barrel exatamente como antes do split.
export { FEEDBACK_SECTIONS };

// ---------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------

// Triagem do professor sobre os indícios de fiscalização (#246). A classificação
// é HUMANA — é o que a torna compatível com a ADR 0004 (proibida acusação ou
// penalidade AUTOMÁTICA).
export async function getProctorReview(submissionId) {
    const r = await pool.query(
        `SELECT proctor_review AS level, proctor_review_note AS note, proctor_reviewed_at AS reviewed_at
           FROM submissions WHERE id = $1`,
        [submissionId]
    );
    return r.rows[0] || null;
}
export async function setProctorReview(submissionId, level, note) {
    const r = await pool.query(
        `UPDATE submissions
            SET proctor_review = $1,
                proctor_review_note = $2,
                proctor_reviewed_at = now(),
                updated_at = now()
          WHERE id = $3
      RETURNING proctor_review AS level, proctor_review_note AS note, proctor_reviewed_at AS reviewed_at`,
        [level, note ?? null, submissionId]
    );
    return r.rows[0] || null;
}

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
        (oral_video_key IS NOT NULL) AS has_oral_video,
        COALESCE(jsonb_array_length(oral_video_parts), 0) AS oral_video_parts_count,
        awaiting_video,
        video_waived,
        -- Retomada bloqueada (#260): sessão de voz caiu com fala do aluno e a
        -- liberação ainda não foi dada. O detalhe fino (wouldResume) vive em
        -- lib/resumeGate.js; este espelho SQL segue o mesmo critério.
        (completion_reason IS NULL
            AND is_test = false
            AND resume_allowed_at IS NULL
            AND (
                (oral_transcript IS NOT NULL
                    AND jsonb_path_exists(oral_transcript, '$[*] ? (@.role == "student")'))
                -- #283: fala real sem texto (sessão 100% alucinada) também conta
                OR COALESCE((oral_voice_json->>'student_speech_events')::int, 0) > 0
            )
        ) AS resume_blocked,
        (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(oral_transcript, '[]'::jsonb)) e
          WHERE e->>'role' = 'student') AS oral_student_turns,
        proctor_review,
        proctor_review_note,
        -- Avaliação PARCIAL (#362): o cálculo de quantas questões foram
        -- neutralizadas é feito em JS, abaixo. Aqui só trazemos o texto.
        grades_json,
        (oral_eval_json IS NOT NULL) AS has_oral_eval,
        (oral_proctor_json IS NOT NULL) AS has_oral_proctor,
        oral_proctor_json,
        oral_voice_json,
        oral_calibration_json,
        ${STATUS_EXPR} AS status
      FROM submissions
      WHERE work_id = $1
      ORDER BY created_at ASC, id ASC
    `, [workId]);
    // `grades_json` é TEXT (não jsonb, ao contrário das colunas vizinhas), então
    // a leitura é em JS — mesma convenção de getPublishedStudentGrade, abaixo.
    //
    // E é em JS por um motivo além da convenção: qualquer expressão JSON no SQL
    // desta consulta pode DERRUBAR A LISTAGEM INTEIRA. Foi o que aconteceu ao
    // introduzir a marcação de avaliação parcial (#362): um `->` sobre coluna
    // textual deu "operator does not exist: text -> unknown" e o painel do
    // professor parou de abrir — para todos os trabalhos, não só os afetados.
    // Um adorno de uma linha não pode ter esse alcance; aqui, um valor
    // inesperado vira null e o resto da tela continua de pé.
    // grades_json sai do payload: é o insumo do cálculo, não resultado — e são
    // ~1,4 KB por linha que ninguém consome do outro lado.
    return r.rows.map(({ grades_json, ...row }) => ({
        ...row,
        grade_not_asked: notAskedFromGrades(grades_json),
    }));
}

// Quantas questões foram neutralizadas por não terem sido perguntadas (#362).
// Qualquer entrada inesperada — nula, vazia, JSON inválido, formato antigo —
// vira 0: a marcação é um adorno, e adorno não derruba a listagem de ninguém.
export function notAskedFromGrades(gradesJsonText) {
    if (!gradesJsonText) return 0;
    try { return Number(JSON.parse(gradesJsonText)?.partial?.not_asked) || 0; }
    catch { return 0; }
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

// Conclui a submission RESPEITANDO o gate de vídeo obrigatório (proctoring
// bloqueante). Retorna 'completed' | 'gave_up' | 'awaiting_video'.
//   - give_up SEMPRE conclui (desistência não exige vídeo).
//   - !mandatory: conclui normalmente.
//   - mandatory + complete: só conclui se JÁ houver vídeo (oral_video_key) ou o
//     professor tiver liberado (video_waived). Senão marca awaiting_video=true e
//     NÃO grava completion_reason — a submissão fica "aguardando vídeo" até o
//     upload chegar (ver promoteAwaitingVideo). O comentário do aluno é guardado
//     para a promoção. Idempotente (só age com completion_reason IS NULL).
export async function finalizeWithVideoGate(submissionId, { mandatory, reason, comment = null }) {
    if (reason !== "complete" && reason !== "give_up") {
        throw new Error(`finalizeWithVideoGate: reason inválida (${reason})`);
    }
    const trimmed = typeof comment === "string" ? comment.trim() : null;
    const finalComment = trimmed && trimmed.length > 0 ? trimmed : null;
    let cleared = reason === "give_up" || !mandatory;
    if (!cleared) {
        const st = await pool.query(
            `SELECT (oral_video_key IS NOT NULL) AS has_video, video_waived FROM submissions WHERE id = $1`,
            [submissionId]
        );
        cleared = !!(st.rows[0]?.has_video || st.rows[0]?.video_waived);
    }
    if (cleared) {
        await pool.query(
            `UPDATE submissions
                SET completion_reason = $1, completed_at = now(),
                    student_comment = COALESCE($2, student_comment),
                    awaiting_video = false, updated_at = now()
              WHERE id = $3 AND completion_reason IS NULL`,
            [reason, finalComment, submissionId]
        );
        return reason === "give_up" ? "gave_up" : "completed";
    }
    await pool.query(
        `UPDATE submissions
            SET awaiting_video = true,
                student_comment = COALESCE($1, student_comment), updated_at = now()
          WHERE id = $2 AND completion_reason IS NULL`,
        [finalComment, submissionId]
    );
    return "awaiting_video";
}

// Chamado pelos endpoints de upload de vídeo: se a submissão estava "aguardando
// vídeo", promove para concluída agora que o vídeo chegou. Idempotente e inócuo
// quando não havia gate pendente. Retorna true se promoveu.
export async function promoteAwaitingVideo(submissionId) {
    const r = await pool.query(
        `UPDATE submissions
            SET completion_reason = 'complete', completed_at = now(),
                awaiting_video = false, updated_at = now()
          WHERE id = $1 AND awaiting_video = true AND completion_reason IS NULL
          RETURNING id`,
        [submissionId]
    );
    return r.rowCount > 0;
}

// Liberação manual do professor: marca a submissão como isenta de vídeo. Se
// estava aguardando vídeo, conclui agora (válvula de escape p/ incompatibilidade
// de câmera/navegador do aluno).
export async function waiveSubmissionVideo(submissionId) {
    await pool.query(
        `UPDATE submissions
            SET video_waived = true,
                completion_reason = CASE WHEN awaiting_video THEN 'complete' ELSE completion_reason END,
                completed_at = CASE WHEN awaiting_video THEN now() ELSE completed_at END,
                awaiting_video = false, updated_at = now()
          WHERE id = $1`,
        [submissionId]
    );
}

// --- Liberação de RETOMADA (issue #260, ver lib/resumeGate.js) ---
// O professor marca a liberação; a próxima conexão de retomada a CONSOME
// (volta a NULL). Cada nova queda exige nova liberação.

export async function allowResume(submissionId) {
    await pool.query(
        `UPDATE submissions SET resume_allowed_at = now(), updated_at = now() WHERE id = $1`,
        [submissionId]
    );
}

// Leitura sem consumir — para as rotas de STATUS informarem a página do aluno.
export async function hasResumeAllowance(submissionId) {
    const r = await pool.query(`SELECT resume_allowed_at FROM submissions WHERE id = $1`, [submissionId]);
    return !!r.rows[0]?.resume_allowed_at;
}

// Consome atomicamente: true se havia liberação (e a zerou), false se não havia.
// Atômico de propósito — duas conexões simultâneas do mesmo token não podem
// consumir a mesma liberação duas vezes.
export async function consumeResumeAllowance(submissionId) {
    const r = await pool.query(
        `UPDATE submissions SET resume_allowed_at = NULL, updated_at = now()
          WHERE id = $1 AND resume_allowed_at IS NOT NULL`,
        [submissionId]
    );
    return r.rowCount > 0;
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
// `client` opcional: quando a reserva de cota do pacote (Gate B) precisa criar os
// tokens e reservar os assentos na MESMA transação (ver routes/work.js + lib/
// packages.js#reserveSeats), o caller passa o client transacional. Retorna `id`
// (interno) além do token — usado para linkar a reserva; o caller o remove antes
// de responder ao frontend.
export async function createSubmissionsFromLabels(workId, labels, isTest = false, client = pool) {
    const rows = [];
    for (const label of labels) {
        const submissionToken = newToken();
        const r = await client.query(
            `INSERT INTO submissions (submission_token, work_id, student_label, is_test)
             VALUES ($1, $2, $3, $4)
             RETURNING id, submission_token, student_label, is_test`,
            [submissionToken, workId, label, !!isTest]
        );
        rows.push({ ...r.rows[0], status: "pending", is_blocked: false });
    }
    return rows;
}

// Atalho legado: `count` submissions com labels derivados de baseLabel
// (`baseLabel` se count=1, `baseLabel-i` caso contrário). Mantido porque a UI
// ainda oferece o modo "rótulo único + quantidade".
export async function createSubmissions(workId, baseLabel, count, isTest = false, client = pool) {
    const labels = [];
    for (let i = 0; i < count; i++) {
        labels.push(count > 1 ? `${baseLabel}-${i + 1}` : baseLabel);
    }
    return createSubmissionsFromLabels(workId, labels, isTest, client);
}

// Apaga uma submissão. Só usar em token NÃO iniciado (o caller garante status
// pending). A devolução do assento do pacote é feita ANTES, por releaseForSubmission.
// client opcional (default pool): participa da transação do caller — a devolução
// de cota e este delete precisam ser atômicos (issue #145).
export async function deleteSubmission(submissionId, client = pool) {
    const r = await client.query(`DELETE FROM submissions WHERE id = $1`, [submissionId]);
    return r.rowCount > 0;
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
        s.consent_version                   AS consent_version,
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
        w.interview_variant                 AS work_interview_variant,
        w.voice                             AS work_voice,
        w.question_count                    AS work_question_count,
        w.max_follow_ups                    AS work_max_follow_ups,
        w.interviewer_name                  AS work_interviewer_name,
        w.interviewer_gender                AS work_interviewer_gender,
        w.expect_spontaneous                AS work_expect_spontaneous,
        w.proctoring_enabled                AS work_proctoring_enabled,
        w.kind                              AS work_kind,
        w.exam_pdf IS NOT NULL              AS work_has_exam,
        COALESCE(jsonb_array_length(w.oral_questions), 0) AS work_oral_question_count,
        w.budget_usd::float8                AS work_budget_usd,
        w.spent_usd::float8                 AS work_spent_usd,
        w.is_benchmark                      AS work_is_benchmark,
        w.benchmark_run_id                  AS work_benchmark_run_id
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
        consent_version: row.consent_version || null,
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
        work_interview_variant: row.work_interview_variant || "messages",
        work_voice: row.work_voice,
        work_question_count: row.work_question_count,
        work_max_follow_ups: row.work_max_follow_ups == null ? null : Number(row.work_max_follow_ups),
        work_interviewer_name: row.work_interviewer_name,
        work_interviewer_gender: row.work_interviewer_gender,
        work_expect_spontaneous: row.work_expect_spontaneous === true,
        work_proctoring_enabled: row.work_proctoring_enabled === true,
        work_kind: row.work_kind || "interview",
        work_has_exam: row.work_has_exam === true,
        work_oral_question_count: Number(row.work_oral_question_count ?? 0),
        work_budget_usd: row.work_budget_usd,
        work_spent_usd: row.work_spent_usd,
        work_is_benchmark: row.work_is_benchmark === true,
        work_benchmark_run_id: row.work_benchmark_run_id || null,
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

// Boolean barato: "já houve tentativa de entrevista nesta submissão?".
// Olha o LOG DA CONVERSA, não o PDF — o PDF é gravado pela prep em background
// antes de existir conversa, então PDF presente não prova tentativa nenhuma
// (ver lib/interviewResume.js). Evita trazer o texto inteiro quando só
// precisamos do booleano.
export async function hasConversationLog(submissionId) {
    const r = await pool.query(
        "SELECT (conversation_json IS NOT NULL) AS present FROM submissions WHERE id = $1",
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

// Versão do consentimento aceito por uma submission. Útil pra detectar
// gravações capturadas sob termo antigo (sem cláusula de retenção).
export async function setSubmissionConsentVersion(submissionId, version) {
    await pool.query(
        `UPDATE submissions SET consent_version = $1, updated_at = now() WHERE id = $2`,
        [version, submissionId]
    );
}

// Preparação da entrevista SIMPLIFICADA (tempo real): {analysis, plan,
// prepared_at, ...} do PrepBuilderAgent, gerada no upload. Ver migration 050.
export async function setLivePrep(submissionId, prep) {
    await pool.query(
        "UPDATE submissions SET live_prep_json = $1, updated_at = now() WHERE id = $2",
        [prep == null ? null : JSON.stringify(prep), submissionId]
    );
}
export async function getLivePrep(submissionId) {
    const r = await pool.query("SELECT live_prep_json FROM submissions WHERE id = $1", [submissionId]);
    const p = r.rows[0]?.live_prep_json;
    return p && typeof p === "object" ? p : null;
}

// Dashboard de Operações (issue #265): "alunos usando agora" na entrevista POR
// MENSAGENS. Não existe sessão nesse fluxo (é requisição a requisição), então a
// definição é OPERACIONAL e explícita na tela: submissão em andamento com
// atividade nos últimos 10 minutos (cada turno faz um UPDATE atômico →
// updated_at é um bom proxy de atividade). Voz ao vivo NÃO passa por aqui — vem
// do registro de sessões do relay (lib/realtimeBridge.js).
export async function countActiveMessageInterviews(windowMinutes = 10) {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM submissions s JOIN works w ON w.id = s.work_id
          WHERE w.kind = 'interview'
            AND COALESCE(w.interview_variant, 'messages') = 'messages'
            AND s.completion_reason IS NULL
            AND s.conversation_json IS NOT NULL
            AND s.updated_at > now() - ($1 || ' minutes')::interval`,
        [windowMinutes]
    );
    return r.rows[0]?.n || 0;
}

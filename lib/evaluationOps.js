// Operações de avaliação compartilhadas entre as rotas individuais e os lotes
// do professor (routes/work.js). Extraídas de work.js sem mudança de
// comportamento: aqui vivem as funções que avaliam UMA submissão (avaliação
// interna, devolutiva ao aluno, notas, publicação) mais os helpers puros que
// elas usam. As ROTAS e a infra de LOTE continuam em routes/work.js — este
// módulo só concentra as ops.
//
// Erros "esperados" (entrevista sem respostas, insumos ausentes) saem com
// err.notReady=true e err.httpStatus — o lote os trata como "pulada".

import * as db from "./db.js";
import log from "./logger.js";
import { uploadPdf } from "./openaiFiles.js";
import { interviewEvaluatorAgent, studentFeedbackAgent, gradingAgent } from "./agents.js";
import { weightedFinal, getEffectiveRubric } from "./rubric.js";
import { applyPenaltyToGrades } from "./gradePenalty.js";

// Avalia UMA submissão (compartilhada entre a rota individual e o lote).
// Erros "esperados" (entrevista sem respostas, insumos ausentes) saem com
// err.notReady=true e err.httpStatus — o lote os trata como "pulada".
export async function evaluateSubmissionNow(work, found, { force }) {
    const subToken = found.submission_token;
    if (!force) {
        const cached = await db.getEvaluationCache(found.id);
        if (cached) {
            log.info("EVALUATION", `cache hit submission=${subToken}`);
            return { evaluation: cached.report, evaluated_at: cached.evaluated_at, cached: true };
        }
    }

    const notReady = (msg, httpStatus) => Object.assign(new Error(msg), { notReady: true, httpStatus });

    const conversationText = await db.getConversationJson(found.id);
    if (!conversationText) throw notReady("a entrevista ainda não começou — nada para avaliar", 409);
    let conversation;
    try { conversation = JSON.parse(conversationText); }
    catch (err) {
        log.error("EVALUATION", `conversation parse failed submission=${subToken}: ${err.message}`);
        throw new Error("failed to read conversation");
    }
    const answeredTurns = (Array.isArray(conversation.turns) ? conversation.turns : [])
        .filter(t => typeof t?.answer === "string" && t.answer.trim());
    if (answeredTurns.length === 0) throw notReady("a entrevista ainda não tem respostas — nada para avaliar", 409);

    const [enunciadoBlob, studentBlob, interviewerYamlText] = await Promise.all([
        db.getEnunciadoBlob(work.id),
        db.getStudentPdfBlob(found.id),
        db.getInterviewerYaml(work.id),
    ]);
    if (!enunciadoBlob) throw notReady("enunciado ausente — não dá para avaliar", 400);
    if (!studentBlob) throw notReady("trabalho do aluno ausente — não dá para avaliar", 400);
    if (!interviewerYamlText) throw notReady("entrevistador não configurado — não dá para avaliar", 400);

    let audioArtifacts = [];
    try {
        audioArtifacts = await db.listStudentAudioArtifactsForSubmission(found.id);
    } catch (err) {
        log.error("EVALUATION", `audio list failed submission=${subToken}: ${err.message}`);
    }

    log.info("EVALUATION", `start submission=${subToken} turns=${answeredTurns.length} audio=${audioArtifacts.length} force=${force}`);
    const [enunciadoUpload, studentUpload] = await Promise.all([
        uploadPdf(enunciadoBlob, "enunciado.pdf"),
        uploadPdf(studentBlob, "trabalho.pdf"),
    ]);
    log.info("EVALUATION", `uploaded files enunciado=${enunciadoUpload.id} trabalho=${studentUpload.id}`);

    const report = await interviewEvaluatorAgent.evaluate({
        enunciadoFileId: enunciadoUpload.id,
        studentFileId: studentUpload.id,
        interviewerYamlText,
        conversation,
        audioArtifacts,
        expectSpontaneous: work.expect_spontaneous === true,
        meterCtx: { workId: work.id },
    });
    const evaluatedAt = await db.setEvaluationCache(found.id, report);
    log.info("EVALUATION", `ok submission=${subToken} defense=${report.overall.defense_quality}`);
    return { evaluation: report, evaluated_at: evaluatedAt, cached: false };
}

// Chaves de seção aceitas nos PATCHes (espelha db.FEEDBACK_SECTIONS). A nota
// NÃO é seção: é publicação própria (grade_published_at), ver rotas grade-publish.
export const SECTION_KEYS = ["interviewer_opinion", "strengths", "improvement_areas", "study_suggestions"];

// Defaults de visibilidade do trabalho, no formato de db.setSubmissionSections.
export function workSectionDefaults(work) {
    return {
        interviewer_opinion: work.include_interviewer_opinion !== false,
        strengths: work.include_strengths !== false,
        improvement_areas: work.include_improvement_areas !== false,
        study_suggestions: work.include_study_suggestions !== false,
    };
}

export function studentEvaluationPayload(student) {
    return {
        student_evaluation: student?.report ?? null,            // efetiva: base − seções desligadas + opinião se ligada
        student_evaluation_base: student?.base_report ?? null,  // base sem filtro (para o editor)
        student_evaluation_auto: student?.auto_report ?? null,
        student_evaluation_at: student?.generated_at ?? null,
        student_evaluation_edited: student?.edited_report ?? null,
        student_evaluation_edited_at: student?.edited_at ?? null,
        published_at: student?.published_at ?? null,
        sections: student?.sections ?? null,                    // visibilidade por seção
        section_has: student?.section_has ?? null,              // presença de conteúdo por seção
        // compat
        include_interviewer_opinion: student?.include_interviewer_opinion ?? true,
        has_interviewer_opinion: student?.has_interviewer_opinion ?? false,
    };
}

// Gera a versão AUTOMÁTICA (sem publicar). force=true regenera; a versão
// editada (se houver) não é tocada — ela continua sendo a efetiva até o
// professor restaurar a automática.
// guidelinesOverride: undefined = usa as diretrizes do trabalho (lote);
// string|null = diretriz AD-HOC desta geração (experimento do professor num
// aluno, sem alterar o padrão do trabalho).
export async function deriveStudentVersionNow(work, found, { force, guidelinesOverride }) {
    const subToken = found.submission_token;
    const internal = await db.getEvaluationCache(found.id);
    if (!internal) {
        throw Object.assign(
            new Error("não há avaliação do entrevistador para esta submissão — avalie antes de gerar a devolutiva"),
            { notReady: true, httpStatus: 409 }
        );
    }
    const existing = await db.getStudentEvaluation(found.id);
    if (existing?.auto_report && !force) {
        return { ...studentEvaluationPayload(existing), generated: false };
    }
    const guidelines = guidelinesOverride === undefined ? (work.feedback_guidelines ?? null) : guidelinesOverride;
    // Seções que o professor decidiu exibir neste aluno: o agente dobra as
    // ocultas no summary (resumo autossuficiente).
    const visibleSections = await db.getSubmissionSections(found.id);
    log.info("PUBLISH", `derive student feedback submission=${subToken} force=${force} guidelines=${guidelines ? "yes" : "no"}${guidelinesOverride !== undefined ? " (ad-hoc)" : ""} sections=${JSON.stringify(visibleSections)}`);
    const report = await studentFeedbackAgent.derive({
        internalReport: internal.report,
        guidelines,
        visibleSections,
        meterCtx: { workId: work.id },
    });
    await db.setStudentEvaluation(found.id, report);
    const student = await db.getStudentEvaluation(found.id);
    return { ...studentEvaluationPayload(student), generated: true };
}

// Publica a versão EFETIVA existente. Nunca gera.
// Calcula as NOTAS de uma submissão (compartilhada entre a rota individual e o
// lote). Uma chamada de LLM por critério (em paralelo); a nota final é a média
// ponderada calculada em código. rubricOverride: undefined = rubrica do
// trabalho (lote/padrão); array = rubrica AD-HOC deste aluno (experimento, não
// muta o padrão). Sem avaliação interna, sai com notReady (o lote pula).
export async function gradeSubmissionNow(work, found, { force, rubricOverride }) {
    const subToken = found.submission_token;
    const internal = await db.getEvaluationCache(found.id);
    if (!internal) {
        throw Object.assign(
            new Error("não há avaliação do entrevistador para esta submissão — avalie antes de calcular as notas"),
            { notReady: true, httpStatus: 409 }
        );
    }
    const existing = await db.getSubmissionGrades(found.id);
    if (existing && !force && rubricOverride === undefined) {
        return { grades: existing, generated: false };
    }
    const rubric = rubricOverride ?? getEffectiveRubric(work);
    log.info("GRADING", `grade submission=${subToken} force=${force} criteria=${rubric.length}${rubricOverride !== undefined ? " (ad-hoc)" : ""}`);
    const scored = await Promise.all(rubric.map(async (criterion) => {
        const { score, justification } = await gradingAgent.grade({
            internalReport: internal.report,
            criterion,
            meterCtx: { workId: work.id },
        });
        return { id: criterion.id, name: criterion.name, weight: criterion.weight, score, justification };
    }));
    const gradesObj = { criteria: scored, final: weightedFinal(scored), computed_at: new Date().toISOString() };
    // Critério fixo de penalidade por alertas de autoria (opt-in) — após a média
    // ponderada. O relatório interno já está em mãos (evita refetch).
    await applyPenaltyToGrades(work, found.id, gradesObj, "interview", internal.report);
    await db.setSubmissionGrades(found.id, gradesObj);
    log.info("GRADING", `ok submission=${subToken} final=${gradesObj.final}`);
    return { grades: gradesObj, generated: true };
}

// Saneia uma nota manual do professor: número em [0,10], 1 casa. null se inválida.
export function clampGrade(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10;
}

export async function publishSubmissionNow(work, found) {
    const student = await db.getStudentEvaluation(found.id);
    if (!student) {
        throw Object.assign(
            new Error("não há devolutiva gerada para esta submissão — gere (e revise) antes de publicar"),
            { notReady: true, httpStatus: 409 }
        );
    }
    const publishedAt = await db.setEvaluationPublished(found.id, true);
    log.info("PUBLISH", `published submission=${found.submission_token} edited=${!!student.edited_report}`);
    return { ...studentEvaluationPayload(student), published_at: publishedAt };
}

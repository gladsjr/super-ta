// Devolutiva RICA da prova oral. Espelha lib/evaluationOps.js#deriveStudentVersionNow
// da entrevista, mas adapta a saída ao armazenamento em TEXTO da oral
// (submissions.oral_devolutiva). Reusa o StudentFeedbackAgent via um SHIM que
// converte o relatório do OralExamEvaluatorAgent (oral_eval_json) no formato de
// relatório interno que o agente espera.
//
// Privacidade: o proctoring NÃO entra na devolutiva do aluno (é sinal de
// integridade para revisão humana; seu efeito na nota é o critério de penalidade,
// e sua leitura fica no painel do professor). A devolutiva se baseia na rubrica
// per-questão + o resumo da avaliação.

import * as db from "./db.js";
import log from "./logger.js";
import { studentFeedbackAgent } from "./agents.js";

// oral_eval_json → relatório interno no formato do StudentFeedbackAgent.
// turn_index = índice da questão (o agente valida per_question.turn_index contra
// este conjunto). Carrega assessment (determinístico) OU score (rubrica) + comentário.
export function buildOralInternalReport(oralEval) {
    const pq = oralEval && Array.isArray(oralEval.per_question) ? oralEval.per_question : [];
    return {
        summary: typeof oralEval?.summary === "string" ? oralEval.summary : "",
        per_question: pq.map((q, i) => ({
            turn_index: i,
            question: String(q.question || ""),
            student_answer: String(q.student_answer || ""),
            ...(q.assessment != null ? { assessment: q.assessment } : {}),
            ...(Number.isFinite(Number(q.score)) ? { score: Number(q.score) } : {}),
            comment: String(q.comment || ""),
        })),
    };
}

// Achata a devolutiva estruturada do StudentFeedbackAgent num TEXTO legível para
// o campo oral_devolutiva (que o professor edita como texto livre). Só inclui as
// seções que o professor escolheu exibir; o summary é sempre o corpo.
export function flattenDevolutiva(fb, visibleSections = {}) {
    const parts = [];
    if (fb?.summary && fb.summary.trim()) parts.push(fb.summary.trim());
    if (Array.isArray(fb?.per_question) && fb.per_question.length) {
        const qs = fb.per_question
            .map(q => `• ${q.question_gist ? q.question_gist.trim() + " — " : ""}${String(q.feedback || "").trim()}`)
            .filter(s => s.length > 2);
        if (qs.length) parts.push("Comentários por questão:\n" + qs.join("\n"));
    }
    const sec = (key, title) => {
        if (visibleSections[key] === false) return;
        const list = Array.isArray(fb?.[key]) ? fb[key].filter(s => typeof s === "string" && s.trim()) : [];
        if (list.length) parts.push(`${title}:\n` + list.map(s => "• " + s.trim()).join("\n"));
    };
    sec("strengths", "Pontos fortes");
    sec("improvement_areas", "O que pode melhorar");
    sec("study_suggestions", "Sugestões de estudo");
    return parts.join("\n\n");
}

// Gera a devolutiva de UMA prova oral. Exige avaliação (oral_eval_json). Sem force,
// preserva a devolutiva já existente (edição manual do professor ou geração anterior).
// Retorna { generated:boolean, skipped?:boolean, reason?:string }.
export async function deriveOralDevolutivaNow(work, submissionId, { force = false } = {}) {
    const detail = await db.getOralSubmissionDetail(submissionId);
    if (!detail || !detail.oral_eval_json) return { generated: false, reason: "no_eval" };
    if (!force && detail.oral_devolutiva && String(detail.oral_devolutiva).trim()) {
        return { generated: false, skipped: true };
    }

    const internalReport = buildOralInternalReport(detail.oral_eval_json);
    const visibleSections = {
        strengths: work.include_strengths !== false,
        improvement_areas: work.include_improvement_areas !== false,
        study_suggestions: work.include_study_suggestions !== false,
    };
    // "Incluir opinião do examinador": vira um adendo às diretrizes (o
    // StudentFeedbackAgent não gera um bloco de opinião — pedimos no prompt).
    let guidelines = typeof work.feedback_guidelines === "string" ? work.feedback_guidelines.trim() : "";
    if (work.include_interviewer_opinion) {
        const nudge = "Inclua no corpo uma breve apreciação geral do examinador sobre o desempenho do aluno na arguição.";
        guidelines = guidelines ? `${guidelines}\n${nudge}` : nudge;
    }

    const fb = await studentFeedbackAgent.derive({
        internalReport,
        guidelines: guidelines || null,
        visibleSections,
        meterCtx: { workId: work.id, submissionId },
    });
    const text = flattenDevolutiva(fb, visibleSections);
    await db.setOralDevolutiva(submissionId, text);
    log.info("ORAL", `devolutiva gerada sub=${submissionId} len=${text.length}`);
    return { generated: true };
}

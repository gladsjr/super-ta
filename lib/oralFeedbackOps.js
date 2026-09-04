// Devolutiva RICA da prova oral. Espelha lib/evaluationOps.js#deriveStudentVersionNow
// da entrevista, mas adapta a saída ao armazenamento em TEXTO da oral
// (submissions.oral_devolutiva). Reusa o StudentFeedbackAgent via um SHIM que
// converte o relatório do OralExamEvaluatorAgent (oral_eval_json) no formato de
// relatório interno que o agente espera.
//
// Proctoring na devolutiva: o corpo dela vem da rubrica per-questão + o resumo da
// avaliação. A fiscalização só aparece como menção SUAVE, governada pelo prompt do
// professor (works.devolutiva_proctor_prompt) e filtrada pela TRIAGEM HUMANA
// (ADR 0017) — nunca como acusação (ADR 0004). O parágrafo anterior aqui dizia
// que o proctoring não entrava de jeito nenhum; era verdade quando foi escrito e
// deixou de ser sem que a nota fosse atualizada (#361).

import * as db from "./db.js";
import log from "./logger.js";
import { studentFeedbackAgent } from "./agents.js";
import { composeProctorForDevolutiva } from "./proctorReview.js";

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
// guidelinesOverride (espelha a entrevista): undefined = usa as diretrizes do
// trabalho; string/null = override ad-hoc SÓ desta geração (não toca o padrão).
// Retorna { generated:boolean, skipped?:boolean, reason?:string }.
export async function deriveOralDevolutivaNow(work, submissionId, { force = false, guidelinesOverride = undefined } = {}) {
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
    let guidelines = guidelinesOverride !== undefined
        ? (typeof guidelinesOverride === "string" ? guidelinesOverride.trim() : "")
        : (typeof work.feedback_guidelines === "string" ? work.feedback_guidelines.trim() : "");
    if (work.include_interviewer_opinion) {
        const nudge = "Inclua no corpo uma breve apreciação geral do examinador sobre o desempenho do aluno na arguição.";
        guidelines = guidelines ? `${guidelines}\n${nudge}` : nudge;
    }
    // Sessão INTERROMPIDA (#362): a devolutiva precisa dizer isso.
    //
    // Sem esse contexto, o aluno que desistiu no meio recebe um texto escrito
    // como se a arguição tivesse corrido inteira — e uma nota calculada sobre
    // menos perguntas parece arbitrária. Dizer o que foi considerado é o que
    // torna o número defensável para quem o recebe.
    if (detail.completion_reason === "give_up") {
        const avaliadas = internalReport.per_question.length;
        const contexto = `A sessão foi INTERROMPIDA antes do fim. Abra a devolutiva reconhecendo isso em uma frase, `
            + `sem cobrança e sem especular o motivo, e deixe claro que a avaliação considerou as ${avaliadas} pergunta(s) `
            + `efetivamente respondida(s) — as que não chegaram a ser feitas foram neutralizadas e NÃO contam contra a nota.`;
        guidelines = guidelines ? `${guidelines}\n${contexto}` : contexto;
    }

    // Proctoring por vídeo (mesma coluna/lib da entrevista): menção suave na devolutiva
    // quando houver relatório, governada por works.devolutiva_proctor_prompt.
    //
    // A TRIAGEM do professor governa o que chega ao aluno (ADR 0017) — era o que
    // faltava aqui (#361): a devolutiva da oral repetia o alerta automático mesmo
    // depois de o professor marcar "sem problema", desfazendo o ato dele.
    //   - 'sem_problema'   -> revisou e descartou: o alerta automático NÃO vai;
    //   - 'confirmado_*'   -> o juízo dele entra, em linguagem formativa;
    //   - 'nao_revisado' / 'em_aberto' -> só o resumo automático, porque
    //                         inconclusivo não é achado.
    // Mesma composição de lib/evaluationOps.js#deriveStudentVersionNow.
    const review = await db.getProctorReview(submissionId);
    const proctoringSummary = composeProctorForDevolutiva(review, detail.oral_proctor_json);
    const fb = await studentFeedbackAgent.derive({
        internalReport,
        guidelines: guidelines || null,
        visibleSections,
        proctoringSummary,
        proctoringInstruction: work.devolutiva_proctor_prompt || null,
        meterCtx: { workId: work.id, submissionId },
    });
    const text = flattenDevolutiva(fb, visibleSections);
    await db.setOralDevolutiva(submissionId, text);
    log.info("ORAL", `devolutiva gerada sub=${submissionId} len=${text.length}`);
    return { generated: true };
}

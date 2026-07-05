// Critério FIXO de penalidade por alertas, aplicado APÓS o cálculo da nota pela
// rubrica. Opt-in por trabalho (works.grade_penalty_json = {enabled, prompt}).
// O GradePenaltyAgent lê os alertas + a política do professor e devolve um
// multiplicador 0..1; a nota final vira base*multiplicador. Simétrico:
//   - prova oral      → alertas de proctoring de vídeo + voz;
//   - entrevista msg  → sinais de autoria da avaliação interna.
// Sem alertas relevantes ⇒ multiplicador 1 (sem chamar o LLM).

import * as db from "./db.js";
import log from "./logger.js";
import { gradePenaltyAgent } from "./agents.js";

function round1(n) { return Math.round(n * 10) / 10; }

// Alertas de proctoring/voz (oral) em texto, nos mesmos limiares dos badges do
// painel (proctorAlerts/voiceAlert) — o que é "alerta" na tabela é o que penaliza.
export function renderOralAlerts(proctor, voice) {
    const lines = [];
    const f = proctor && proctor.flags;
    if (f) {
        if (f.absent && f.absent.pct >= 20) lines.push(`Ausência do candidato em ${f.absent.pct}% dos frames analisados.`);
        if (f.multiple_people && f.multiple_people.pct >= 20) lines.push(`Mais de uma pessoa no enquadramento em ${f.multiple_people.pct}% dos frames.`);
        if (f.phone && f.phone.pct >= 25) lines.push(`Celular detectado em ${f.phone.pct}% dos frames.`);
        if (f.hands && f.hands.flag) lines.push(`Mãos fora do quadro em parte relevante da prova.`);
        if (f.framing && f.framing.flag) lines.push(`Enquadramento fora do padrão por trecho contínuo.`);
    }
    if (voice && voice.latency && voice.latency.flagged_count > 0) {
        lines.push(`${voice.latency.flagged_count} resposta(s) com pausa longa antes de o aluno começar a falar.`);
    }
    return lines.join("\n");
}

// Sinais de autoria (entrevista) em texto. authorship_confidence 'high' sem
// sinais de dúvida ⇒ sem alerta. 'low'/'medium' ou sinais que "questionam" ⇒ alerta.
export function renderAuthorshipAlerts(evalJson) {
    if (!evalJson || typeof evalJson !== "object") return "";
    const conf = evalJson.overall && evalJson.overall.authorship_confidence;
    const signals = Array.isArray(evalJson.authorship_signals)
        ? evalJson.authorship_signals.filter(s => s && s.direction === "questions")
        : [];
    if ((conf === "high" || conf == null) && !signals.length) return "";
    const lines = [];
    if (conf) lines.push(`Confiança de que a autoria é do próprio aluno: ${conf}.`);
    for (const s of signals) lines.push(`Sinal que questiona a autoria: ${s.signal}${s.where ? ` (em ${s.where})` : ""}.`);
    const di = evalJson.delivery && evalJson.delivery.overall_impression;
    if (di === "scripted") lines.push("Entrega geral com forte cara de texto preparado/lido.");
    return lines.join("\n");
}

// Aplica a penalidade a um objeto `grades` (mutando-o): grava grades.penalty e
// recalcula grades.final = base*multiplicador. `flow` = "oral" | "interview".
// Para interview, passe `internalReport` (evaluation_json) para evitar refetch.
export async function applyPenaltyToGrades(work, submissionId, grades, flow, internalReport = null) {
    const policy = work && work.grade_penalty_json;
    if (!policy || !policy.enabled) return grades;
    if (!grades || !Number.isFinite(Number(grades.final))) return grades;

    let alertsText = "";
    if (flow === "oral") {
        const d = await db.getOralSubmissionDetail(submissionId);
        alertsText = renderOralAlerts(d && d.oral_proctor_json, d && d.oral_voice_json);
    } else {
        // Entrevista: o chamador (evaluationOps) passa o relatório interno em mãos.
        if (!internalReport) return grades;
        alertsText = renderAuthorshipAlerts(internalReport);
    }

    const base = round1(Number(grades.final));
    if (!alertsText.trim()) {
        // Critério ligado, mas nada a penalizar — registra transparência sem LLM.
        grades.penalty = { multiplier: 1, justification: "Sem alertas relevantes de integridade.", base, source: flow, applied_at: new Date().toISOString() };
        return grades;
    }

    try {
        const { multiplier, justification } = await gradePenaltyAgent.assess({
            alertsText, policyPrompt: policy.prompt, meterCtx: { workId: work.id, submissionId },
        });
        grades.penalty = { multiplier, justification, base, source: flow, applied_at: new Date().toISOString() };
        grades.final = round1(base * multiplier);
        log.info("PENALTY", `flow=${flow} sub=${submissionId} base=${base} x${multiplier} => ${grades.final}`);
    } catch (err) {
        // Falha na penalidade não deve derrubar o cálculo da nota — registra e mantém a base.
        log.error("PENALTY", `flow=${flow} sub=${submissionId} falhou: ${err.message}`);
        grades.penalty = { multiplier: 1, justification: "Não foi possível aplicar a penalidade (erro); nota mantida.", base, source: flow, applied_at: new Date().toISOString() };
    }
    return grades;
}

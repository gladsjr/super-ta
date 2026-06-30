// Helpers internos compartilhados entre os módulos de db/ após o split de
// lib/db.js. NÃO são re-exportados pelo barrel (lib/db.js) — são detalhe de
// implementação consumido por works.js, submissions.js etc.

import crypto from "crypto";

// 12 hex chars = 6 random bytes. Same convention as the legacy filesystem
// layout used.
export function newToken() {
    return crypto.randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------
// Status derivation (shared SQL fragment)
// ---------------------------------------------------------------------

// Ordem importa: finalização (completion_reason) vence o estado derivado dos
// blobs. Valores de completion_reason: 'complete' | 'give_up' (ver
// finalizeSubmission). 'gave_up'/'completed' são os rótulos derivados.
export const STATUS_EXPR = `
  CASE
    WHEN completion_reason = 'give_up' THEN 'gave_up'
    WHEN completion_reason IS NOT NULL THEN 'completed'
    WHEN student_pdf IS NOT NULL OR conversation_json IS NOT NULL THEN 'in_progress'
    ELSE 'pending'
  END
`;

// ---------------------------------------------------------------------
// Seções da devolutiva (mapeamento seção→coluna)
// ---------------------------------------------------------------------

// Seções da devolutiva e a coluna de visibilidade correspondente na submission
// (e o default no work). interviewer_opinion é especial: o conteúdo NÃO vive
// na versão do aluno — é a interviewer_impression do relatório interno.
//
// FEEDBACK_SECTIONS é export PÚBLICA (re-exportada por submissions.js → barrel).
// Vive aqui porque appendSectionSets (helper interno) e dois módulos
// (submissions.js + works.js) dependem do mapeamento; pô-lo em _shared.js evita
// que works.js re-exporte appendSectionSets pelo barrel.
export const FEEDBACK_SECTIONS = [
    { key: "interviewer_opinion", column: "include_interviewer_opinion", field: null },
    { key: "strengths", column: "include_strengths", field: "strengths" },
    { key: "improvement_areas", column: "include_improvement_areas", field: "improvement_areas" },
    { key: "study_suggestions", column: "include_study_suggestions", field: "study_suggestions" },
];

// Acrescenta a `sets`/`vals` os pares "coluna = $N" para cada seção de
// FEEDBACK_SECTIONS presente (boolean) em `sections`. Muta os arrays. Fonte
// única do mapeamento seção→coluna usada por setWorkFeedbackSettings e
// setSubmissionSections (antes duplicado nos dois). Helper INTERNO — não é
// re-exportado pelo barrel.
export function appendSectionSets(sets, vals, sections) {
    for (const s of FEEDBACK_SECTIONS) {
        if (typeof sections?.[s.key] === "boolean") {
            vals.push(sections[s.key]);
            sets.push(`${s.column} = $${vals.length}`);
        }
    }
}

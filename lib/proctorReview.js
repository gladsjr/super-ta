// TRIAGEM do professor sobre os indícios de fiscalização (issue #246).
//
// O professor vê um sinal na lista, entra na avaliação do aluno, assiste aos
// trechos e forma um juízo — e até agora não tinha onde registrá-lo. A triagem
// se perdia: não dava para retomar depois, nem para a avaliação e a devolutiva
// levarem em conta o que ele concluiu.
//
// A classificação é HUMANA, o que a torna compatível com a ADR 0004 (proibida
// acusação/penalidade AUTOMÁTICA). As guardas que a ADR impõe continuam:
//   - a nota NÃO muda sozinha em função do rótulo (quem ajusta é o professor);
//   - a devolutiva menciona o ponto em linguagem formativa, sem acusar;
//   - `nao_revisado` e `sem_problema` NÃO entram na devolutiva.
//
// Enumeração em TABELA + FK (ADR 0011): estes níveis podem evoluir, e mudar a
// definição de um CHECK mantendo o nome NÃO propaga no Publish do Replit. A
// tabela `proctor_review_levels` é sincronizada por seed a partir desta constante.

import { renderProctorForStudent } from "./gradePenalty.js";

export const PROCTOR_REVIEW_DEFS = [
    // `nao_revisado` é DISTINTO de `em_aberto` de propósito: sem essa diferença
    // não dá para saber o que falta revisar — que é a fila de trabalho do professor.
    { key: "nao_revisado", name: "Não revisado", ordem: 0, confirmado: false, naDevolutiva: false },
    { key: "sem_problema", name: "Sem problema", ordem: 1, confirmado: false, naDevolutiva: false },
    { key: "em_aberto", name: "Em aberto", ordem: 2, confirmado: false, naDevolutiva: false },
    { key: "confirmado_leve", name: "Confirmado — leve", ordem: 3, confirmado: true, naDevolutiva: true },
    { key: "confirmado_moderado", name: "Confirmado — moderado", ordem: 4, confirmado: true, naDevolutiva: true },
    { key: "confirmado_grave", name: "Confirmado — grave", ordem: 5, confirmado: true, naDevolutiva: true },
];

export const PROCTOR_REVIEW_KEYS = PROCTOR_REVIEW_DEFS.map(d => d.key);
export const PROCTOR_REVIEW_DEFAULT = "nao_revisado";

export const proctorReviewDef = (key) =>
    PROCTOR_REVIEW_DEFS.find(d => d.key === key) || PROCTOR_REVIEW_DEFS[0];

export const isValidProctorReview = (key) => PROCTOR_REVIEW_KEYS.includes(key);

// `em_aberto` NÃO entra na devolutiva: inconclusivo não é achado, e comunicar
// dúvida ao aluno como se fosse constatação seria exatamente o tipo de acusação
// implícita que a ADR 0004 proíbe.
export const entraNaDevolutiva = (key) => !!proctorReviewDef(key).naDevolutiva;

// Bloco de fiscalização que vai à devolutiva do ALUNO. FONTE ÚNICA da regra da
// ADR 0017, consumida pela entrevista (lib/evaluationOps.js) e pela prova oral
// (lib/oralFeedbackOps.js).
//
// Existe porque a regra estava escrita duas vezes e a prova oral esqueceu a
// metade que importa (#361): a devolutiva repetia o alerta automático mesmo
// depois de o professor marcar "sem problema" — o aluno lia uma insinuação que
// um humano já havia examinado e descartado. Com duas cópias, a terceira
// arguição que surgir repete o erro; com uma, não há como esquecer.
//
// `proctorJson` deve vir null quando não há relatório ou quando a fiscalização
// está desligada no trabalho — quem decide isso é o chamador, que conhece o
// works.proctoring_enabled. Devolve null quando não há nada a dizer.
export function composeProctorForDevolutiva(review, proctorJson) {
    // 'sem_problema': o professor revisou e descartou. O automático não vai.
    const automatico = review?.level === "sem_problema" ? null : renderProctorForStudent(proctorJson);
    // 'confirmado_*': o juízo dele entra, em linguagem formativa. Os demais
    // níveis não entram (inconclusivo não é achado).
    const doProfessor = renderProctorReviewForPrompt(review, { paraDevolutiva: true });
    return [doProfessor, automatico].filter(Boolean).join("\n\n") || null;
}

// Bloco de texto para os PROMPTS (avaliação interna e devolutiva). Devolve null
// quando não há nada a dizer — o chamador então não injeta seção alguma.
export function renderProctorReviewForPrompt(review, { paraDevolutiva = false } = {}) {
    const key = review?.level || PROCTOR_REVIEW_DEFAULT;
    const def = proctorReviewDef(key);
    const nota = String(review?.note || "").trim();

    if (paraDevolutiva) {
        if (!entraNaDevolutiva(key)) return null;
        return [
            "TRIAGEM DO PROFESSOR SOBRE A FISCALIZAÇÃO (revisão HUMANA do vídeo):",
            `- Conclusão do professor: ${def.name}.`,
            nota ? `- Observação dele: ${nota}` : null,
            "COMO TRATAR: mencione o ponto em linguagem FORMATIVA e em segunda pessoa,",
            "descrevendo o combinado da atividade e o que se espera adiante. NÃO acuse,",
            "NÃO impute causa (trapaça, IA, plágio) e NÃO atribua nota ou juízo global.",
        ].filter(Boolean).join("\n");
    }

    if (key === PROCTOR_REVIEW_DEFAULT && !nota) return null;
    return [
        "TRIAGEM DO PROFESSOR SOBRE A FISCALIZAÇÃO (revisão HUMANA do vídeo):",
        `- Conclusão do professor: ${def.name}.`,
        nota ? `- Observação dele: ${nota}` : null,
        def.confirmado
            ? "Considere isto como contexto CONFIRMADO por revisão humana ao ler os sinais do vídeo."
            : "O professor revisou e NÃO confirmou problema — não trate os sinais do vídeo como achado.",
    ].filter(Boolean).join("\n");
}

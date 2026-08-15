// Rubrica ESTRUTURADA da prova oral (issue #195). Cada questão passa a ter a
// rubrica como 5 NÍVEIS de nota FIXA (10 / 7,5 / 5 / 2,5 / 0), cada um com um
// texto de CRITÉRIO (o que caracteriza aquele nível). O avaliador escolhe UM
// nível e a nota é exatamente a dele.
//
// Compatibilidade (fallback): questões antigas têm a rubrica como STRING livre
// (`rubric`). Enquanto não forem regeradas, seguem valendo — os helpers abaixo
// caem na string quando não há `rubric_levels` preenchidos. Ponto único de leitura
// para todos os consumidores (editor, gerador, avaliador, cota, diff de stale).

// Notas fixas, em ordem decrescente (a de cima é a melhor). NÃO mudar sem alinhar
// com o avaliador e o gerador — as âncoras estão espelhadas nos prompts.
export const RUBRIC_LEVELS = [10, 7.5, 5, 2.5, 0];

// "7,5" em vez de "7.5" para a UI/prompt em pt-BR.
export function fmtScore(s) {
    return String(s).replace(".", ",");
}

// Normaliza para os 5 níveis na ordem canônica, com criteria string. Aceita um
// array parcial/desordenado (por score) ou lixo → devolve sempre os 5, vazios onde
// faltar. NÃO inventa critérios: só reordena/saneia o que veio.
export function normalizeRubricLevels(raw) {
    const byScore = {};
    if (Array.isArray(raw)) {
        for (const lv of raw) {
            const s = Number(lv?.score);
            if (RUBRIC_LEVELS.includes(s)) byScore[s] = String(lv?.criteria ?? "").trim();
        }
    }
    return RUBRIC_LEVELS.map(score => ({ score, criteria: byScore[score] || "" }));
}

// Há pelo menos um critério preenchido nos níveis?
export function hasLevels(levels) {
    return Array.isArray(levels) && levels.some(l => String(l?.criteria || "").trim());
}

// A questão TEM rubrica utilizável? (níveis preenchidos OU a string legada). Usado
// pela cota, pela geração e pela guarda "avalie só com rubrica".
export function questionHasRubric(q) {
    return hasLevels(q?.rubric_levels) || !!String(q?.rubric || "").trim();
}

// Texto da rubrica para INJETAR no prompt do avaliador: dos 5 níveis quando há,
// senão a string legada (fallback). Formato legível e ancorado às notas.
export function rubricForPrompt(q) {
    const levels = q?.rubric_levels;
    if (hasLevels(levels)) {
        return normalizeRubricLevels(levels)
            .map(l => `Nota ${fmtScore(l.score)}: ${l.criteria || "(sem critério para este nível)"}`)
            .join("\n");
    }
    return String(q?.rubric || "").trim();
}

// Igualdade de rubrica (para o diff de rubric_stale): compara os níveis quando há,
// senão a string legada. Estável à ordem (normaliza antes).
export function sameRubric(a, b) {
    const la = hasLevels(a?.rubric_levels), lb = hasLevels(b?.rubric_levels);
    if (la || lb) {
        return JSON.stringify(normalizeRubricLevels(a?.rubric_levels)) === JSON.stringify(normalizeRubricLevels(b?.rubric_levels));
    }
    return String(a?.rubric || "").trim() === String(b?.rubric || "").trim();
}

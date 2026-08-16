// Quem entra num LOTE que custa LLM (avaliação, devolutiva, notas, proctoring).
//
// Regra (issue #258): o lote avalia quem de fato FEZ a arguição. Ficam de fora
// envio de teste, arguição em andamento e desistência — essas só são avaliadas
// se o professor pedir INDIVIDUALMENTE, que é uma decisão explícita dele.
//
// Antes o filtro era "status !== 'pending'", o que deixava entrar tudo que não
// estivesse zerado: seis desistências já tinham sido avaliadas em lote em
// produção, e envios de teste concluídos entravam como qualquer aluno.
//
// FONTE ÚNICA de propósito: a entrevista filtra em JS (sobre as linhas de
// listSubmissionsForWork) e a prova oral filtra em SQL. As duas leituras têm de
// dizer a mesma coisa, então moram no mesmo arquivo.

// Fragmento SQL para as consultas que montam fila de lote. Pressupõe que a
// tabela `submissions` está no escopo (com ou sem alias — passe o prefixo).
export const batchEligibleSql = (alias = "") => {
    const p = alias ? `${alias}.` : "";
    return `${p}is_test = false
            AND ${p}completion_reason IS NOT NULL
            AND ${p}completion_reason <> 'give_up'`;
};

// Mesma regra em JS, sobre uma linha de listSubmissionsForWork.
export function isBatchEligible(s) {
    if (!s) return false;
    if (s.is_test === true) return false;
    return s.status === "completed";
}

// Por que uma submissão ficou de fora — para o lote CONTAR e o professor saber
// que ela existe, em vez de achar que o sistema a esqueceu.
export function batchIneligibleReason(s) {
    if (!s) return "desconhecida";
    if (s.is_test === true) return "envio de teste";
    switch (s.status) {
        case "completed": return null; // elegível
        case "gave_up": return "desistência";
        case "awaiting_video": return "aguardando o vídeo";
        case "in_progress": return "arguição em andamento";
        case "pending": return "sem envio";
        default: return "não concluída";
    }
}

// Resumo dos excluídos, agrupado por motivo: { "desistência": 3, ... }.
export function summarizeIneligible(subs) {
    const out = {};
    for (const s of subs || []) {
        const r = batchIneligibleReason(s);
        if (r) out[r] = (out[r] || 0) + 1;
    }
    return out;
}

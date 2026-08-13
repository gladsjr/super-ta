// Contagem LEVE de páginas de um PDF, sem dependência externa. Serve de guardrail
// de custo (limitar o tamanho do material que vai ao LLM). Heurística, com
// fail-open: se não der para estimar com confiança, devolve null e o chamador
// NÃO bloqueia (melhor deixar passar do que barrar um PDF válido por engano).
//
// Estratégia:
//   1) /Count N no page-tree — o maior valor costuma ser a raiz de páginas.
//   2) fallback: contar ocorrências de "/Type /Page" (não "/Pages").
// PDFs com object streams comprimidos podem esconder esses marcadores nos bytes
// crus; nesse caso a estimativa é null (fail-open).

export const MAX_PDF_PAGES = 50;

export function estimatePdfPageCount(buffer) {
    if (!buffer || !buffer.length) return null;
    try {
        const s = buffer.toString("latin1");
        const counts = [...s.matchAll(/\/Count\s+(\d+)/g)]
            .map(m => parseInt(m[1], 10))
            .filter(n => Number.isFinite(n) && n > 0);
        if (counts.length) return Math.max(...counts);
        const pages = (s.match(/\/Type\s*\/Page(?![s])/g) || []).length;
        return pages > 0 ? pages : null;
    } catch {
        return null;
    }
}

// true = deve BLOQUEAR (estimativa confiável acima do limite). null/desconhecido
// nunca bloqueia.
export function exceedsPageLimit(buffer, limit = MAX_PDF_PAGES) {
    const n = estimatePdfPageCount(buffer);
    return n != null && n > limit;
}

// Concorrência limitada reutilizável (lotes I/O-bound: chamadas a modelo, DB).

/**
 * Executa `fn(item, index)` sobre `items` com no máximo `limit` em voo ao mesmo
 * tempo, e resolve quando todos terminam. Pool de workers simples: cada worker
 * puxa o próximo índice (incremento SÍNCRONO — sem corrida no modelo
 * single-thread do JS) até esgotar. Use quando rodar tudo de uma vez estouraria
 * limite de taxa/recurso (ex.: N avaliações de raciocínio em paralelo).
 *
 * `fn` cuida do próprio tratamento de erro quando tem efeito colateral por item
 * (ex.: streaming NDJSON). Para coletar resultados, use o retorno.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit  máximo de execuções simultâneas (>= 1)
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ok:true,value:R}|{ok:false,error:Error}>>} um
 *   resultado por item, NA ORDEM de `items`. Um item que lança vira
 *   `{ok:false,error}` — o lote nunca rejeita por causa de um item.
 */
export async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++; // síncrono: sem await entre ler e incrementar
            try { results[i] = { ok: true, value: await fn(items[i], i) }; }
            catch (e) { results[i] = { ok: false, error: e }; }
        }
    };
    const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
}

// Rubrica de notas da entrevista — lógica PURA (sem LLM, sem banco). Fonte
// única dos defaults, da validação de forma e do cálculo da nota final. Mantida
// separada do GradingAgent para ser testável sem instanciar o cliente OpenAI.
//
// Um critério: { id, name, weight, prompt }. A rubrica é um array de critérios.
// A nota de cada critério (0..10) é calculada pelo GradingAgent aplicando o
// `prompt` sobre a avaliação interna completa; a nota final é a média ponderada
// pelos `weight` (normalizados pela soma — pesos 1/1, 30/40/30 ou % funcionam).

import { randomUUID } from "crypto";

export const GRADE_MIN = 0;
export const GRADE_MAX = 10;

// Os dois critérios default (peso igual → 50/50). O professor pode editar
// nomes, pesos e prompts, ou adicionar/remover critérios. Ambos os prompts
// capturam o nível de satisfação do stakeholder correspondente.
export const DEFAULT_RUBRIC = [
    {
        id: "interviewer",
        name: "Avaliação do entrevistador",
        weight: 1,
        prompt: "Com base na avaliação completa, dê uma nota de 0 a 10 que reflita o quanto o ENTREVISTADOR (a persona da cena) ficou satisfeito com a forma como o respondente sustentou o trabalho diante dele: quão convincente foi a defesa, a consistência com a entrega e a profundidade ao ser provocado. Justifique em 1–2 frases.",
    },
    {
        id: "professor",
        name: "Avaliação do professor",
        weight: 1,
        prompt: "Com base na avaliação completa, dê uma nota de 0 a 10 que reflita o nível de satisfação do PROFESSOR com o desempenho do estudante na entrevista, do ponto de vista de aprendizado e domínio demonstrado. Justifique em 1–2 frases.",
    },
];

// Valida e NORMALIZA uma rubrica vinda do professor. Lança em qualquer
// problema (a rota traduz para 400). Retorna um novo array de critérios
// saneados: strings trimadas, peso numérico > 0, id garantido (gera um se
// faltar). Não há limite rígido de critérios, mas exige ao menos um.
export function validateRubricShape(criteria) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
        throw new Error("a rubrica precisa de ao menos um critério");
    }
    const seen = new Set();
    return criteria.map((c, i) => {
        if (!c || typeof c !== "object") throw new Error(`critério ${i + 1} inválido`);
        const name = typeof c.name === "string" ? c.name.trim() : "";
        if (!name) throw new Error(`critério ${i + 1}: nome obrigatório`);
        const prompt = typeof c.prompt === "string" ? c.prompt.trim() : "";
        if (!prompt) throw new Error(`critério "${name}": prompt obrigatório`);
        const weight = Number(c.weight);
        if (!Number.isFinite(weight) || weight <= 0) {
            throw new Error(`critério "${name}": peso deve ser um número maior que zero`);
        }
        let id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : randomUUID();
        if (seen.has(id)) id = randomUUID(); // ids duplicados não são confiáveis
        seen.add(id);
        return { id, name, weight, prompt };
    });
}

// Média ponderada das notas por critério, arredondada a 1 casa. `scored` é um
// array [{ weight, score }]. Ignora itens sem nota numérica. Devolve null se
// não há peso válido (nenhuma nota computada ainda).
export function weightedFinal(scored) {
    let num = 0, den = 0;
    for (const c of Array.isArray(scored) ? scored : []) {
        // Nota ausente (null/undefined/"") NÃO conta — senão Number(null)=0 puxaria
        // a média (importa na nota manual, com questões ainda em branco).
        const raw = c?.score;
        if (raw == null || raw === "") continue;
        const w = Number(c?.weight), s = Number(raw);
        if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(s)) continue;
        num += s * w;
        den += w;
    }
    if (den === 0) return null;
    return Math.round((num / den) * 10) / 10;
}

// Lê a rubrica armazenada (TEXT `{ criteria: [...] }`) e devolve o array de
// critérios, ou null se ausente/ilegível.
export function parseStoredRubric(text) {
    if (!text) return null;
    try {
        const obj = JSON.parse(text);
        return Array.isArray(obj?.criteria) && obj.criteria.length > 0 ? obj.criteria : null;
    } catch {
        return null;
    }
}

// A rubrica efetiva de um trabalho: a do professor, ou o DEFAULT_RUBRIC quando
// nunca foi definida. `work.grading_rubric` já vem como array de critérios (ou
// null) — ver o middleware requireWorkToken.
export function getEffectiveRubric(work) {
    const r = work?.grading_rubric;
    return Array.isArray(r) && r.length > 0 ? r : DEFAULT_RUBRIC;
}

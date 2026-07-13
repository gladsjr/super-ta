import { sha256 } from "./util.js";

const STOPWORDS = new Set("a ao aos as de da das do dos e em no na nos nas o os para por que se um uma uns umas com como mais mas ou seu sua seus suas foi ser esta este isso sobre entre quando qual quais".split(" "));

function terms(text) {
    return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]{2,}/g)?.filter((term) => !STOPWORDS.has(term)) || [];
}

function splitText(source, text, maxChars) {
    const paragraphs = String(text || "").split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const chunks = [];
    let current = "";
    for (const paragraph of paragraphs) {
        if (current && current.length + paragraph.length + 2 > maxChars) {
            chunks.push(current); current = "";
        }
        if (paragraph.length > maxChars) {
            if (current) { chunks.push(current); current = ""; }
            for (let start = 0; start < paragraph.length; start += maxChars) chunks.push(paragraph.slice(start, start + maxChars));
        } else current += `${current ? "\n\n" : ""}${paragraph}`;
    }
    if (current) chunks.push(current);
    return chunks.map((content, index) => ({ id: `${source}-${String(index + 1).padStart(3, "0")}`, source, content, hash: sha256(content) }));
}

export function buildChunks(testCase, { chunk_chars = 1800 } = {}) {
    return [
        ...splitText("assignment", testCase.assignment, chunk_chars),
        ...splitText("student_work", testCase.student_work, chunk_chars),
    ];
}

export function retrieveEvidence(testCase, turn, config = {}) {
    const chunks = buildChunks(testCase, config);
    const query = [...turn.history.map((item) => item.text), turn.student_message].join("\n");
    const queryTerms = terms(query);
    const documentFrequency = new Map();
    for (const chunk of chunks) for (const term of new Set(terms(chunk.content))) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    const ranked = chunks.map((chunk) => {
        const chunkTerms = terms(chunk.content);
        const frequencies = new Map();
        for (const term of chunkTerms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
        let score = 0;
        for (const term of queryTerms) {
            const tf = frequencies.get(term) || 0;
            const idf = Math.log((chunks.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1;
            score += tf * idf;
        }
        return { ...chunk, score };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const topK = Math.max(1, Number(config.top_k || 8));
    const selected = ranked.slice(0, Math.min(topK, ranked.length));
    return {
        strategy: "lexical-v1",
        query,
        chunks: selected,
        package_hash: sha256(selected.map(({ id, hash }) => ({ id, hash }))),
        all_chunks_hash: sha256(chunks.map(({ id, hash }) => ({ id, hash }))),
    };
}

export function evidenceText(evidence) {
    return evidence.chunks.map((chunk) => `[${chunk.id} | ${chunk.source}]\n${chunk.content}`).join("\n\n");
}

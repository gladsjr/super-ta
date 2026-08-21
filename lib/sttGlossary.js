// Glossário de domínio para o STT (issue #293).
//
// A bancada (#285, 21/08) provou que o hint de vocabulário conserta a
// corrupção de termo raro NO PROVEDOR ATUAL: o "Cambium Chain" de produção
// virou "câmbio on-chain" com glossário, no mesmo gpt-transcribe que errava
// sem. Este módulo monta esse glossário MECANICAMENTE (zero chamada de LLM —
// ADR 0006) a partir do que a sessão já tem: perguntas do plano, análise do
// trabalho e nome do trabalho.
//
// Disciplina antiviés (a mesma do protocolo validado no incidente de 18/08):
// vocabulário corrige GRAFIA de termo que a fala já traz foneticamente — nunca
// contém o lado de uma disputa específica (números, valores, datas). Por isso
// a extração ignora tokens numéricos, e a CALIBRAÇÃO fica fora do glossário
// (ela MEDE a captação; glossário ali viciaria o termômetro).
//
// Limites conhecidos do v1 (iterar com dados): termo de domínio todo em
// minúsculas e sem hífen ("halving") só entra se aparecer capitalizado em
// algum insumo.

// Palavras all-caps comuns que não são termo de domínio.
const STOP = new Set(["OK", "EU", "US", "USD", "BRL", "PDF", "FGV", "MBA", "IA", "AI", "P", "R"]);

// Um token "parece termo de domínio" quando tem ≥2 maiúsculas (USDC, DeFi,
// MiCA, BRZ, GENIUS, TVL) — o padrão de sigla/marca que o STT mais deforma.
function multiCap(tok) {
    const caps = (tok.match(/\p{Lu}/gu) || []).length;
    return caps >= 2;
}

// Extrai termos de uma lista de textos. Retorna até `max`, por frequência.
export function extractGlossary(texts, { max = 24 } = {}) {
    const freq = new Map(); // chave minúscula → { form, n }
    const add = (form) => {
        const t = form.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (t.length < 2 || t.length > 40) return;
        if (/^\d+$/.test(t)) return;                    // números nunca (antiviés)
        if (STOP.has(t.toUpperCase())) return;
        const k = t.toLowerCase();
        const cur = freq.get(k);
        if (cur) cur.n++;
        else freq.set(k, { form: t, n: 1 });
    };

    for (const raw of texts) {
        const text = String(raw || "");
        // Tokens com ≥2 maiúsculas
        for (const m of text.matchAll(/\b[\p{L}][\p{L}\p{N}$-]*\b/gu)) {
            if (multiCap(m[0])) add(m[0]);
        }
        // Bigramas: Capitalizado seguido de Capitalizado ("GENIUS Act",
        // "Santa Clara"). Lookahead para permitir sobreposição (senão
        // "O GENIUS" consumiria o GENIUS e "GENIUS Act" nunca seria visto);
        // 1ª palavra com ≥2 letras exclui artigos (O, A, E).
        for (const m of text.matchAll(/\b([\p{Lu}][\p{L}\p{N}-]+)\s+(?=([\p{Lu}][\p{L}\p{N}-]+))/gu)) {
            if (multiCap(m[1]) || multiCap(m[2]) || (m[1].length >= 3 && m[2].length >= 3)) add(`${m[1]} ${m[2]}`);
        }
        // Hifenizados de domínio ("on-chain", "e-FX", "peer-to-peer")
        for (const m of text.matchAll(/\b[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+\b/gu)) {
            if (m[0].length >= 4) add(m[0]);
        }
    }

    return [...freq.values()]
        .sort((a, b) => b.n - a.n || a.form.localeCompare(b.form))
        .slice(0, max)
        .map(e => e.form);
}

// Monta (e memoiza em sess.sttGlossary) o glossário da sessão do modo
// mensagem. null quando não há insumo (prep ainda não pronta) — o caller
// simplesmente não passa keywords, comportamento de sempre.
export function glossaryForSession(sess, { workName = null } = {}) {
    if (sess.sttGlossary !== undefined) return sess.sttGlossary;
    const texts = [];
    if (workName) texts.push(workName);
    const qs = sess.interviewPlan?.questions;
    if (Array.isArray(qs)) for (const q of qs) texts.push(typeof q === "string" ? q : q?.question);
    const a = sess.workAnalysis;
    if (a) {
        if (a.summary) texts.push(a.summary);
        for (const arr of [a.strengths, a.weaknesses, a.critical_points]) {
            if (Array.isArray(arr)) texts.push(...arr);
        }
    }
    const terms = extractGlossary(texts);
    sess.sttGlossary = terms.length ? terms : null;
    return sess.sttGlossary;
}

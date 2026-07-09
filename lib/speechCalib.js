// Pontuação do pré-teste de CALIBRAÇÃO DE FALA da prova oral.
//
// Compara a repetição do aluno (transcrita por gpt-4o-transcribe — o MESMO STT que
// gera a transcrição da correção) com a frase-alvo. É tolerante a pontuação, caixa
// e hesitação, e foca na SOBREVIVÊNCIA DOS TERMOS-CHAVE (o jargão do domínio, que é
// o que mais interessa capturar bem) além de um WER geral. Puro e testável — sem I/O.
//
// Limiares padrão (ajustáveis): fala clara repetindo uma frase curta rende WER baixo;
// sinaliza só quando o texto diverge bastante OU quando MAIS DE UM termo-chave não
// sobrevive. NÃO são calibrados empiricamente (os áudios de produção que temos são
// respostas livres, não repetições de alvo) — são defaults de bom senso, fáceis de
// ajustar aqui.
export const CALIB_WER_MAX = 0.30;        // WER acima disso -> sinaliza
export const CALIB_KEYTERM_FUZZ = 0.34;   // distância de caractere relativa p/ um termo "sobreviver"
export const CALIB_MAX_MISSED_TERMS = 1;  // tolera até N termos-chave perdidos antes de sinalizar

// Hesitações comuns em pt-BR: não contam como erro de fala (removidas dos dois lados).
const FILLERS = new Set(["é", "ééé", "eh", "ah", "ahn", "hã", "ha", "hm", "hmm", "né", "uh", "aa", "ãã"]);

export function normalize(s) {
    return String(s || "")
        .normalize("NFC").toLowerCase()
        .replace(/[^\p{L}\p{N}%]+/gu, " ") // mantém letras, dígitos e "%"; resto vira espaço
        .replace(/\s+/g, " ").trim();
}

function words(s, dropFillers = false) {
    const t = normalize(s).split(" ").filter(Boolean);
    return dropFillers ? t.filter(w => !FILLERS.has(w)) : t;
}

// Levenshtein genérico sobre arrays (de palavras ou de caracteres).
export function levenshtein(a, b) {
    const n = a.length, m = b.length;
    if (!n) return m;
    if (!m) return n;
    let prev = Array.from({ length: m + 1 }, (_, i) => i);
    for (let i = 1; i <= n; i++) {
        const cur = [i];
        for (let j = 1; j <= m; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[m];
}

// WER (taxa de erro por palavra) com hesitações removidas dos dois lados.
// null quando a referência é vazia.
export function wordErrorRate(reference, hypothesis) {
    const r = words(reference, true);
    const h = words(hypothesis, true);
    if (!r.length) return null;
    return levenshtein(r, h) / r.length;
}

// Um termo-chave (1+ palavras) "sobrevive" se aparece na hipótese com distância de
// caractere relativa pequena — tolera "hashrate"/"hash rate", plural e pequenas
// trocas fonéticas. Testa janelas de palavras coladas do tamanho do termo (±1).
export function keyTermSurvives(term, hypothesis, fuzz = CALIB_KEYTERM_FUZZ) {
    const t = normalize(term).replace(/\s+/g, "");
    if (!t) return true; // termo vazio: ignora
    const hw = words(hypothesis);
    const n = normalize(term).split(" ").filter(Boolean).length || 1;
    const maxSpan = Math.min(hw.length, n + 1);
    for (let span = Math.max(1, n - 1); span <= maxSpan; span++) {
        for (let i = 0; i + span <= hw.length; i++) {
            const cand = hw.slice(i, i + span).join("");
            const d = levenshtein([...t], [...cand]) / Math.max(t.length, 1);
            if (d <= fuzz) return true;
        }
    }
    return false;
}

/**
 * Pontua a repetição do aluno contra a frase-alvo + termos-chave.
 * @param {object} p
 * @param {string} p.target        frase-alvo (o que o aluno devia repetir)
 * @param {string[]} [p.keyTerms]  termos do domínio a checar
 * @param {string} p.hypothesis    transcrição da fala do aluno
 * @returns {{ ok:boolean, wer:number|null, missedTerms:string[], werOk:boolean, termsOk:boolean }}
 */
export function scoreCalibration({ target, keyTerms = [], hypothesis, werMax = CALIB_WER_MAX, fuzz = CALIB_KEYTERM_FUZZ, maxMissed = CALIB_MAX_MISSED_TERMS }) {
    const wer = wordErrorRate(target, hypothesis);
    const terms = (keyTerms || []).map(x => String(x || "").trim()).filter(Boolean);
    const missedTerms = terms.filter(t => !keyTermSurvives(t, hypothesis, fuzz));
    const werOk = wer == null ? true : wer <= werMax;
    const termsOk = missedTerms.length <= maxMissed;
    return { ok: werOk && termsOk, wer, missedTerms, werOk, termsOk };
}

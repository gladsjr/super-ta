// Detector algorítmico de trechos ininteligíveis numa transcrição com logprobs.
// Sem LLM. Pura função sobre o array de tokens devolvido pelo gpt-4o-transcribe
// quando include:["logprobs"] é pedido em lib/audio.js#transcribeAudio.
//
// Filosofia: a decisão "pedir repetição ou não" é numérica, não cognitiva. O
// LLM (AudioIntelligibilityAgent) entra só depois, para fraseiar o pedido em
// personagem — ele recebe os trechos já delimitados.
//
// Saída quando há trechos: { spans: [{text, startIdx, endIdx, ...}], aggregate }.
// Saída quando o enunciado é curto demais ou claro: { spans: [], aggregate }.
//
// O caller (routes/interview.js) lê `spans.length === 0` como "passa direto"
// e `spans.length > 0` como "vai precisar de repetição".

// Reconstrói o texto de uma sequência de tokens a partir do campo `bytes`.
// Os tokens do gpt-4o-transcribe são sub-word; concatenar `token` direto pode
// trazer marcadores BPE; concatenar `bytes` e decodificar como UTF-8 dá o texto
// original do trecho.
function decodeTokensRange(logprobs, startIdx, endIdx) {
    const bytes = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const tb = logprobs[i]?.bytes;
        if (Array.isArray(tb)) {
            for (const b of tb) bytes.push(b);
        } else if (typeof logprobs[i]?.token === "string") {
            // Fallback se bytes não vier (não deveria, mas seguro).
            const buf = Buffer.from(logprobs[i].token, "utf8");
            for (const b of buf) bytes.push(b);
        }
    }
    try {
        return Buffer.from(bytes).toString("utf8");
    } catch {
        return "";
    }
}

// Expande as fronteiras de um trecho até a próxima/anterior fronteira de palavra
// no texto reconstruído pelo trecho EXPANDIDO + tokens vizinhos. Para fins
// práticos: enquanto o texto reconstruído começar/terminar no meio de uma
// palavra (sem espaço/pontuação adjacente), inclui o token vizinho. Limita
// expansão a `maxExtra` tokens de cada lado para não engolir o enunciado todo.
function expandToWordBoundary(logprobs, startIdx, endIdx, maxExtra = 3) {
    const isBoundaryByte = (b) => b === 0x20 /* space */ || b === 0x0a /* \n */ || b === 0x09 /* \t */
        || (b >= 0x21 && b <= 0x2f) /* ! " # $ % & ' ( ) * + , - . / */
        || (b >= 0x3a && b <= 0x40) /* : ; < = > ? @ */;

    let s = startIdx;
    let e = endIdx;

    // Expande à esquerda enquanto o primeiro byte do span não for fronteira
    // E o token anterior existir E houver folga.
    let leftBudget = maxExtra;
    while (leftBudget > 0 && s > 0) {
        const firstBytes = logprobs[s]?.bytes;
        const firstByte = Array.isArray(firstBytes) && firstBytes.length ? firstBytes[0] : null;
        if (firstByte !== null && isBoundaryByte(firstByte)) break;
        s -= 1;
        leftBudget -= 1;
    }

    // Expande à direita até o ÚLTIMO byte do span ser fronteira, ou folga acabar.
    let rightBudget = maxExtra;
    while (rightBudget > 0 && e < logprobs.length - 1) {
        const lastBytes = logprobs[e]?.bytes;
        const lastByte = Array.isArray(lastBytes) && lastBytes.length ? lastBytes[lastBytes.length - 1] : null;
        if (lastByte !== null && isBoundaryByte(lastByte)) break;
        e += 1;
        rightBudget -= 1;
    }

    return { startIdx: s, endIdx: e };
}

// `policy` é { low_logprob_threshold, min_consecutive_low_tokens,
// min_utterance_tokens }. O caller passa o bloco lido de policy.yaml com defaults.
//
// `logprobs` é Array<{ token, bytes, logprob }> conforme tipo da SDK
// (node_modules/openai/resources/audio/transcriptions.d.ts:38).
//
// Devolve { spans, aggregate } onde:
//   spans     — Array<{ text, startIdx, endIdx, length }>
//                  cada trecho já expandido para fronteira de palavra.
//   aggregate — { totalTokens, lowTokens, meanLogprob, minLogprob }
//                  resumo numérico do enunciado inteiro, útil para log/auditoria.
//
// Quando `logprobs` é null/vazio (modelo não devolveu), o detector é no-op:
// devolve spans vazio e aggregate null. O sistema segue normalmente.
export function detectIntelligibilitySpans(logprobs, policy) {
    if (!Array.isArray(logprobs) || logprobs.length === 0) {
        return { spans: [], aggregate: null };
    }
    const T = Number(policy.low_logprob_threshold);
    const K = Math.max(1, Math.floor(Number(policy.min_consecutive_low_tokens) || 0));
    const M = Math.max(0, Math.floor(Number(policy.min_utterance_tokens) || 0));

    // Métricas agregadas (sempre úteis para log).
    let sumLogprob = 0;
    let countWithLogprob = 0;
    let minLogprob = Infinity;
    let lowTokens = 0;
    for (const tp of logprobs) {
        if (typeof tp?.logprob === "number") {
            sumLogprob += tp.logprob;
            countWithLogprob += 1;
            if (tp.logprob < minLogprob) minLogprob = tp.logprob;
            if (tp.logprob < T) lowTokens += 1;
        }
    }
    const aggregate = {
        totalTokens: logprobs.length,
        lowTokens,
        meanLogprob: countWithLogprob > 0 ? sumLogprob / countWithLogprob : null,
        minLogprob: minLogprob === Infinity ? null : minLogprob,
    };

    // Piso: enunciados curtos não gateiam — evita falso-positivo em "ok", "sim",
    // nomes próprios curtos, etc.
    if (logprobs.length < M) {
        return { spans: [], aggregate };
    }

    // Varre buscando runs consecutivos de tokens com logprob < T.
    const rawSpans = [];
    let runStart = -1;
    for (let i = 0; i < logprobs.length; i++) {
        const lp = logprobs[i]?.logprob;
        const low = typeof lp === "number" && lp < T;
        if (low) {
            if (runStart === -1) runStart = i;
        } else if (runStart !== -1) {
            const runLen = i - runStart;
            if (runLen >= K) rawSpans.push({ startIdx: runStart, endIdx: i - 1 });
            runStart = -1;
        }
    }
    // Run terminando no fim do array.
    if (runStart !== -1) {
        const runLen = logprobs.length - runStart;
        if (runLen >= K) rawSpans.push({ startIdx: runStart, endIdx: logprobs.length - 1 });
    }

    if (rawSpans.length === 0) {
        return { spans: [], aggregate };
    }

    // Expande cada trecho para fronteiras de palavra e reconstrói o texto.
    const spans = rawSpans.map(r => {
        const expanded = expandToWordBoundary(logprobs, r.startIdx, r.endIdx);
        const text = decodeTokensRange(logprobs, expanded.startIdx, expanded.endIdx).trim();
        return {
            text,
            startIdx: expanded.startIdx,
            endIdx: expanded.endIdx,
            length: expanded.endIdx - expanded.startIdx + 1,
        };
    }).filter(s => s.text.length > 0);

    return { spans, aggregate };
}

// Maior sequência de tokens consecutivos com logprob < T.
function maxConsecutiveBelow(logprobs, T) {
    let max = 0, cur = 0;
    for (const tp of logprobs) {
        if (typeof tp?.logprob === "number" && tp.logprob < T) { cur++; if (cur > max) max = cur; }
        else cur = 0;
    }
    return max;
}

// Classifica o áudio do aluno em TRÊS desfechos a partir dos logprobs do STT:
//   "seguir"  — confiança ok; segue normal (sem Dica).
//   "avisar"  — alguns trechos incertos; o entrevistador responde NORMAL + Dica
//               não-bloqueante destacando os trechos. Aluno não regrava.
//   "repetir" — trecho sustentado ruim (run longo) ou proporção muito alta; pede
//               repetição + Dica. NUNCA descarta — reter contexto é com o caller.
// Os `spans` (trechos incertos, p/ a Dica) são detectados no limiar de AVISO.
// Enunciados curtos (< min_utterance_tokens) sempre "seguir".
export function classifyAudio(logprobs, policy) {
    const warn = detectIntelligibilitySpans(logprobs, {
        low_logprob_threshold: policy.warn_logprob_threshold,
        min_consecutive_low_tokens: 1,   // destaca até trechos curtos incertos
        min_utterance_tokens: policy.min_utterance_tokens,
    });
    const agg = warn.aggregate;
    if (!agg || agg.totalTokens < policy.min_utterance_tokens) {
        return { outcome: "seguir", spans: [], aggregate: agg, metrics: null };
    }
    const total = agg.totalTokens;
    const nWarn = agg.lowTokens;                       // tokens < limiar de aviso
    const pctWarn = total > 0 ? nWarn / total : 0;
    const maxRunRepeat = maxConsecutiveBelow(logprobs, policy.repeat_logprob_threshold);
    let outcome;
    if (maxRunRepeat >= policy.repeat_consecutive || pctWarn >= policy.repeat_pct) outcome = "repetir";
    else if (pctWarn >= policy.warn_pct) outcome = "avisar";
    else outcome = "seguir";
    return { outcome, spans: warn.spans, aggregate: agg, metrics: { nWarn, pctWarn, maxRunRepeat } };
}

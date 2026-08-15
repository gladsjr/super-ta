// Alertas de TRANSCRIÇÃO da prova oral / entrevista realtime (issue #137).
//
// Problema: em silêncio, ruído ou eco, o STT do Realtime "inventa" texto sem que
// o aluno tenha falado — e o VAD (create_response) faz o examinador RESPONDER a
// esse nada, consumindo perguntas. A assinatura clássica dessa alucinação é texto
// CURTO, SEM SENTIDO e frequentemente em OUTRO IDIOMA/SCRIPT (comportamento
// conhecido do Whisper e afins ao gravar silêncio).
//
// O gpt-transcribe NÃO devolve logprobs (ver config/policy.yaml), então a detecção
// é puramente TEXTUAL/estrutural — sem custo, sem chamada de modelo. É post-hoc
// sobre a transcrição que já montamos: NUNCA barra a fala ao vivo (evita bloquear
// resposta legítima curta); apenas SINALIZA, para o aluno (na revisão) e o
// professor (no batch/detalhe) revisarem. Não altera a nota.
//
// Só examina os turnos do ALUNO — o examinador é TTS, sempre limpo.

// Scripts que não ocorrem em português: presença de qualquer letra desses scripts
// é indício forte de alucinação (o aluno fala pt-BR). Property escapes do Unicode
// (flag "u"), legíveis e abrangentes.
const FOREIGN_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Armenian}\p{Script=Georgian}]/u;

// "Fala pt" aceitável num caractere: letra, número, espaço e pontuação comum. O
// que sobra (símbolos raros, controles) conta como "estranho".
const OK_CHAR = /[\p{L}\p{N}\s.,;:!?'"()\[\]{}\-–—…/%$@#°ºª+=&*]/u;
// Qualquer letra ou dígito: fala real sempre tem algum. Sua ausência (só pontuação
// ou símbolos, ex.: "...", "♪♪♪") é alucinação de silêncio.
const HAS_ALNUM = /[\p{L}\p{N}]/u;

const MAX_GIBBERISH_LEN = 40;   // "curto": alucinação de ruído costuma ser breve
const ODD_RATIO_GIBBERISH = 0.4; // >40% de caracteres estranhos num trecho curto
const REPEAT_RUN = 3;            // mesma palavra repetida >=3x seguidas (loop de STT)
const SNIPPET_LEN = 80;

function snippet(text) {
    const t = String(text).trim().replace(/\s+/g, " ");
    return t.length > SNIPPET_LEN ? t.slice(0, SNIPPET_LEN) + "…" : t;
}

function oddRatio(text) {
    const chars = [...String(text).replace(/\s/g, "")];
    if (!chars.length) return 0;
    let odd = 0;
    for (const c of chars) if (!OK_CHAR.test(c)) odd++;
    return odd / chars.length;
}

function hasRepeatRun(text) {
    const words = String(text).toLowerCase().match(/\p{L}+/gu) || [];
    let run = 1;
    for (let i = 1; i < words.length; i++) {
        run = words[i] === words[i - 1] ? run + 1 : 1;
        if (run >= REPEAT_RUN) return true;
    }
    return false;
}

// Classifica UM turno do aluno. Retorna a categoria do problema ou null se limpo.
// Ordem: idioma estrangeiro (mais forte) → só-símbolos → ruído curto → repetição.
export function classifyStudentTurn(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    if (FOREIGN_SCRIPT.test(t)) return "idioma_estrangeiro";
    if (!HAS_ALNUM.test(t)) return "ruido";                          // só pontuação/símbolos
    const odd = oddRatio(t);
    if (odd >= 0.6) return "ruido";                                  // quase tudo símbolo
    if (t.length <= MAX_GIBBERISH_LEN && odd >= ODD_RATIO_GIBBERISH) return "ruido";
    if (hasRepeatRun(t)) return "repeticao";
    return null;
}

// Rótulos legíveis por categoria (para a UI).
export const ALERT_LABELS = {
    idioma_estrangeiro: "idioma não reconhecido",
    ruido: "trecho ininteligível",
    repeticao: "repetição anômala",
};

// Varre a transcrição [{role,text}] e devolve o resumo dos alertas de transcrição.
// { count, turns: [{ index, kind, label, snippet }] } — index = posição no array
// original (para a UI destacar o turno certo). count = 0 quando limpo.
export function detectTranscriptAlerts(transcript) {
    const turns = [];
    (Array.isArray(transcript) ? transcript : []).forEach((turn, index) => {
        if (!turn || turn.role !== "student") return;
        const kind = classifyStudentTurn(turn.text);
        if (kind) turns.push({ index, kind, label: ALERT_LABELS[kind], snippet: snippet(turn.text) });
    });
    return { count: turns.length, turns };
}

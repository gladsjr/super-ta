// Sound check v2 (#288): teste de ECO + escada verde/amarelo/vermelho.
//
// Por que existe: a calibração por leitura de frase é estruturalmente cega aos
// modos de falha dominantes do incidente de 18/08 — a Rebeca PASSOU na leitura
// (WER 0,2) e teve 100% de alucinação por ECO (a voz do examinador voltando
// pelo microfone); o George passou "raspando" e degradou no meio. Daqui saem:
//
// - o teste de eco: o servidor toca uma frase com PALAVRAS-MARCADOR distintivas
//   e o aluno fica em silêncio; se o STT do que o microfone captou devolve os
//   marcadores, o eco é REAL (medição direta, não heurística);
// - a escada: VERDE segue · AMARELO segue com aviso persistente · VERMELHO não
//   segue sozinho (checklist -> reagendar -> liberação do professor). Vermelho
//   exige DOIS sinais duros — nunca um turno isolado (ADR 0023).
//
// Recuperação: os sinais duros contam sobre as ÚLTIMAS 2 medições de cada sonda
// — o aluno que corrige o ambiente (ex.: plugou fone com fio) limpa o vermelho
// testando de novo. O histórico não é apagado: worst_wer segue guardando o pior
// resultado (caso George: instabilidade fica registrada como amarelo).
//
// Puro e testável — sem I/O. Limiares iniciais de bom senso, ajustáveis aqui.

import { normalize } from "./speechCalib.js";

// Marcadores: palavras comuns do pt-BR (o STT as transcreve bem), mas
// improváveis numa alucinação de silêncio (que tende a "obrigado", "tchau",
// "legendas" etc.) e sem parentesco fonético entre si.
export const ECHO_MARKERS = ["girassol", "labirinto", "trombone", "veleiro", "alfazema"];
export const ECHO_SENTENCE =
    "Este é o teste de eco. Fique em silêncio, sem falar nada, enquanto eu digo cinco palavras: " +
    "girassol. labirinto. trombone. veleiro. alfazema. Obrigado — o teste terminou.";
export const ECHO_LEAK_MIN_MATCHES = 2; // 1 marcador pode ser coincidência; 2+ é vazamento

export const HARD_WER = 0.6;    // leitura com WER acima disso = reprovação DURA
export const YELLOW_WER = 0.45; // passou, mas o pior resultado ficou perto do limite

// O sound check está PENDENTE? (adendo da ADR 0023: o teste é obrigatório —
// sem medição, o aluno com eco driblaria o gate simplesmente não testando.)
// Concluído = leitura resolvida (aprovada ou tentativas esgotadas) E eco
// testado ao menos uma vez. Liberação do professor também destrava.
export function soundCheckPending(c, maxAttempts = 2) {
    if (c?.waived_at) return false;
    const leituraDone = c?.passed === true || Number(c?.attempts) >= maxAttempts;
    const ecoDone = Number(c?.echo?.tests) > 0;
    return !(leituraDone && ecoDone);
}

// Valida o sinal de HFP reportado pelo navegador (campo `hfp` do FormData da
// calibração). Nunca confia no formato: qualquer coisa torta vira null.
export function parseHfp(raw) {
    if (!raw) return null;
    try {
        const j = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!j || typeof j !== "object") return null;
        return {
            suspect: !!j.suspect,
            label: String(j.label || "").slice(0, 120),
            sample_rate: Number(j.sample_rate) || null,
            hi_ratio: Number.isFinite(Number(j.hi_ratio)) ? Number(j.hi_ratio) : null,
            at: new Date().toISOString(),
        };
    } catch { return null; }
}

// Quantos marcadores distintos aparecem na transcrição do microfone.
export function countEchoMatches(transcript) {
    const seen = new Set(normalize(transcript).split(" ").filter(Boolean));
    let n = 0;
    for (const m of ECHO_MARKERS) if (seen.has(m) || seen.has(m + "s")) n++;
    return n;
}

// Estado da escada a partir do registro consolidado da submissão
// (submissions.oral_calibration_json — leitura + echo + hfp + waived_at).
// null = sem nenhuma medição (trabalho sem sound check — fail-open, como hoje).
export function ladderState(c) {
    if (!c) return null;
    const attempts = Array.isArray(c.transcripts) ? c.transcripts : [];
    const echo = c.echo || null;
    const hfp = c.hfp || null;
    if (!attempts.length && !echo && !hfp) return null;

    // Sinais DUROS sobre as últimas 2 medições de cada sonda (recuperável).
    const hardFails = attempts.slice(-2).filter(t => Number(t.wer) >= HARD_WER).length;
    const recentLeaks = (Array.isArray(echo?.leaks_recent) ? echo.leaks_recent : [])
        .slice(-2).filter(Boolean).length;

    const reasons = [];
    let state = "verde";
    if (hardFails >= 2 || recentLeaks >= 2) {
        state = "vermelho";
        if (hardFails >= 2) reasons.push("duas leituras seguidas com captação muito ruim");
        if (recentLeaks >= 2) reasons.push("eco confirmado em dois testes seguidos");
    } else {
        const worst = Number(c.worst_wer) || 0;
        if (attempts.length && c.passed !== true) { state = "amarelo"; reasons.push("a leitura de teste não foi aprovada"); }
        if (hardFails === 1) { state = "amarelo"; reasons.push("uma leitura com captação muito ruim"); }
        else if (c.passed === true && worst >= YELLOW_WER) { state = "amarelo"; reasons.push("captação instável entre as tentativas"); }
        if (recentLeaks === 1) { state = "amarelo"; reasons.push("eco detectado (a voz do examinador voltou pelo microfone)"); }
        if (hfp?.suspect) { state = "amarelo"; reasons.push("fone Bluetooth em modo chamada (áudio de qualidade reduzida)"); }
    }
    return {
        state, reasons,
        hard_fails: hardFails, echo_leaks: recentLeaks,
        waived: !!c.waived_at,
    };
}

// Planejador de SEGMENTOS para a retranscrição por pergunta (#289, corte 2).
//
// Entrada: o índice de marcas do tee (lib/audioTee.js) — cada marca tem `b`
// (posição no áudio em bytes; b/48000 = segundo EXATO no arquivo) e `type`
// (speech_started/speech_stopped/examiner_done). Saída: os trechos de FALA DO
// ALUNO com início/fim em segundos e a pergunta a que pertencem.
//
// A atribuição de pergunta é POSICIONAL e AUDITÁVEL (condição do cético na
// estratégia: "o mapeamento semântico errado é limpo e falso" — aqui cada
// trecho carrega timestamps e a regra é mecânica): a fala que começa depois do
// k-ésimo examiner_done pertence à pergunta k (1-based). q_idx 0 = fala antes
// da primeira pergunta terminar de tocar (apresentação). O refinamento
// SEMÂNTICO ("voltar ao assunto anterior") é do avaliador, POR CIMA desta
// trilha — nunca a substitui.
//
// Marcas antigas (sem `b`): devolve null — o chamador cai no modo contínuo.

const BYTES_PER_SEC = 48000; // PCM16 mono 24kHz
const MARGIN_S = 0.5;        // folga nas bordas (o VAD atrasa ~centenas de ms)
const MAX_SEGMENTS = 60;     // teto de sanidade (sessão normal tem 5-20 falas)
const MIN_SEG_S = 0.4;       // fala mais curta que isso é ruído de VAD

export function planSegments(index, durationS) {
    if (!Array.isArray(index) || index.length === 0) return null;
    if (!index.every(m => Number.isFinite(m?.b))) return null; // índice antigo (sem b)
    if (!(durationS > 0)) return null;

    const segs = [];
    let examinerDone = 0;
    let openStart = null; // segundos, já com margem

    for (const m of index) {
        const s = m.b / BYTES_PER_SEC;
        if (m.type === "examiner_done") {
            examinerDone++;
        } else if (m.type === "speech_started") {
            if (openStart == null) openStart = Math.max(0, s - MARGIN_S);
        } else if (m.type === "speech_stopped") {
            if (openStart != null) {
                const end = Math.min(durationS, s + MARGIN_S);
                if (end - openStart >= MIN_SEG_S) {
                    segs.push({ start_s: r1(openStart), end_s: r1(end), q_idx: examinerDone });
                }
                openStart = null;
            }
        }
    }
    // Fala aberta no fim da sessão (queda/encerramento no meio) fecha na duração.
    if (openStart != null && durationS - openStart >= MIN_SEG_S) {
        segs.push({ start_s: r1(openStart), end_s: r1(durationS), q_idx: examinerDone });
    }
    if (segs.length === 0 || segs.length > MAX_SEGMENTS) return null;
    return segs;
}

function r1(x) { return Math.round(x * 10) / 10; }

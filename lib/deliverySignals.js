// Sinais de FORMA/ENTREGA das respostas do aluno — fonte única dos limiares,
// bancos de expressões e medidores usados por dois consumidores:
//   - scripts/detect-ai-answers.mjs — relatório forense CLI (varre um work);
//   - agents/InterviewEvaluatorAgent.js — avaliação holística da entrevista
//     (recebe o relatório de buildDeliveryReport como contexto de forma).
//
// IMPORTANTE — natureza dos resultados: sinais HEURÍSTICOS, não prova.
// Há risco real de falso positivo (aluno que digita rápido, fala formal por
// hábito) e de falso negativo. Quem consome decide o peso; aqui só se mede.

// ---------------------------------------------------------------------
// Limiares (ajustáveis). Documentados para auditoria — não são mágicos.
// ---------------------------------------------------------------------
export const TH = {
    // Modo texto: caracteres por segundo entre a pergunta e a resposta.
    // Digitação humana sustentada raramente passa de ~12-15 cps; datilógrafo
    // rápido ~10. Acima disso, numa resposta longa, cheira a colagem.
    PASTE_CPS: 22,
    PASTE_MIN_CHARS: 180, // só vale o sinal de colagem em respostas longas
    // Modo áudio: palavras por segundo do áudio do turno. Fala espontânea em
    // PT ~2-3 wps (120-180 wpm); leitura fluente tende a ser mais alta e MUITO
    // estável. Sinal fraco isolado — combinar com registro escrito + latência.
    FAST_SPEECH_WPS: 3.2,
    // Latência GROSSA (s) do turno inteiro (pergunta→resposta final): inclui o
    // áudio da pergunta tocando, rede, upload, STT e TODOS os follow-ups. Não
    // serve para o alerta de geração externa em ÁUDIO (muito inflada); fica só
    // como dado informativo e ainda alimenta o sinal de TEXTO (onde não há
    // instrumentação de tempo-até-falar). Ver LONG_THINK_GAP_S.
    LONG_LATENCY_S: 75,
    // Tempo de PENSAMENTO por par pergunta-resposta (s): o silêncio puro entre o
    // áudio da pergunta terminar de tocar e o aluno apertar gravar (medido no
    // cliente, Fase 2). É um silêncio LIMPO — exclui playback/rede/upload/STT —,
    // então o limiar é bem menor que o da latência grossa. Calibrado alto para
    // segurar falso-positivo (pensar fundo numa pergunta difícil também demora).
    LONG_THINK_GAP_S: 45,
    // Resposta longa e estruturada o bastante pra parecer gerada.
    LONG_ANSWER_WORDS: 60,
    // Espontaneidade (Fase 2/3): "abriu o microfone mas quase não disse nada".
    // Gravação não-trivial (ms) + pouquíssimas palavras = possível stall (abrir
    // o mic só pra "começar" e ganhar tempo). Anti-gaming do início rápido.
    STALL_OPEN_MS: 3000,
    LOW_CONTENT_WORDS: 5,
};

// Marcadores de formatação típicos de saída de LLM (raros na digitação humana
// apressada de um chat).
export const MD_BULLET = /^[\s>]*[-*•·]\s+/m;
export const MD_NUMBERED = /^[\s>]*\d+[.)]\s+/m;
export const MD_HEADER = /^#{1,6}\s+/m;
export const MD_BOLD = /\*\*[^*\n]+\*\*|__[^_\n]+__/;
export const MD_CODE = /`[^`\n]+`|```/;
export const EM_DASH = /—/g;

// Conectivos / clichês de prosa expositiva formal (registro de LLM em PT-BR).
export const FORMAL_CONNECTORS = [
    /\bé importante (notar|ressaltar|destacar|mencionar)\b/i,
    /\bvale (ressaltar|destacar|notar|mencionar|lembrar)\b/i,
    /\bem (resumo|suma|síntese)\b/i,
    /\bde (modo|maneira) geral\b/i,
    /\bno geral\b/i,
    /\bpor um lado\b/i,
    /\bpor outro lado\b/i,
    /\bademais\b/i,
    /\boutrossim\b/i,
    /\bportanto\b/i,
    /\bdessa forma\b/i,
    /\bdesta forma\b/i,
    /\bsendo assim\b/i,
    /\bem síntese\b/i,
    /\bcabe (ressaltar|destacar)\b/i,
    /\bvisto que\b/i,
];

// Marcadores de REGISTRO ESCRITO numa fala: subordinação e vocabulário de
// prosa expositiva que quase ninguém produz oralmente de improviso, mas que
// um LLM gera o tempo todo. Sinal central do "leu um texto pronto em áudio",
// onde markdown não existe (STT não transcreve formatação).
export const WRITTEN_REGISTER = [
    /\bsegundo (a|o) qual\b/i,
    /\bde modo que\b/i,
    /\bde forma que\b/i,
    /\bde maneira que\b/i,
    /\bao passo que\b/i,
    /\bna medida em que\b/i,
    /\buma vez que\b/i,
    /\btendo em vista\b/i,
    /\bno que (tange|concerne|diz respeito)\b/i,
    /\bconferindo\b/i,
    /\bsustentando\b/i,
    /\bgarantindo\b/i,
    /\bevidenciando\b/i,
    /\bcorroborando\b/i,
    /\bem virtude (de|da|do)\b/i,
    /\bmediante\b/i,
    /\bporquanto\b/i,
    /\bconsoante\b/i,
];

// Marcadores de fala espontânea (disfluências). MUITOS = humano falando ao
// vivo; ZERO numa resposta longa de áudio = possível leitura de texto pronto.
export const DISFLUENCY = [
    /\bé\.\.\.|\beh\b|\bahn?\b|\bhmm+\b|\buhm+\b/i,
    /\btipo\b/i,
    /\bné\b/i,
    /\bassim\b/i,
    /\bsei lá\b/i,
    /\bcomo é que (é|fala|chama)\b/i,
    /\bdeixa eu (ver|pensar)\b/i,
    /\.\.\./,
];

// ---------------------------------------------------------------------
// Medidores
// ---------------------------------------------------------------------
export function words(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
}

export function countMatches(text, regexes) {
    if (!text) return 0;
    let n = 0;
    for (const re of regexes) if (re.test(text)) n++;
    return n;
}

export function secondsBetween(a, b) {
    if (!a || !b) return null;
    const ta = Date.parse(a), tb = Date.parse(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
    return (tb - ta) / 1000;
}

export function num(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

// "Polish score" 0..1 de uma resposta: quão estruturada/formal/sem-fricção é.
// Usado para detectar mudança de registro DENTRO do mesmo aluno.
export function polishScore(text) {
    if (!text) return 0;
    let s = 0;
    if (MD_BULLET.test(text) || MD_NUMBERED.test(text)) s += 0.30;
    if (MD_HEADER.test(text)) s += 0.15;
    if (MD_BOLD.test(text)) s += 0.20;
    if (MD_CODE.test(text)) s += 0.10;
    const fc = countMatches(text, FORMAL_CONNECTORS);
    s += Math.min(0.30, fc * 0.12);
    if ((text.match(EM_DASH) || []).length >= 2) s += 0.10;
    // Pontuação "completa": termina com . ! ? e tem vírgulas — prosa cuidada.
    if (/[.!?]\s*$/.test(text.trim()) && (text.match(/,/g) || []).length >= 2) s += 0.10;
    return Math.min(1, s);
}

// Registro escrito numa FALA transcrita (0..1): frases longas + subordinação
// formal. Captura o "leu texto de IA em voz alta" que o polishScore (baseado
// em markdown) não pega, porque a transcrição não tem formatação.
export function writtenRegisterScore(text) {
    if (!text) return 0;
    let s = 0;
    const sentences = text.split(/[.!?]+/).map(x => x.trim()).filter(Boolean);
    const avgLen = sentences.length ? words(text) / sentences.length : words(text);
    if (avgLen >= 28) s += 0.45;
    else if (avgLen >= 20) s += 0.30;
    else if (avgLen >= 15) s += 0.15;
    const wr = countMatches(text, WRITTEN_REGISTER);
    s += Math.min(0.45, wr * 0.20);
    const fc = countMatches(text, FORMAL_CONNECTORS);
    s += Math.min(0.20, fc * 0.10);
    return Math.min(1, s);
}

export function median(arr) {
    const a = arr.filter(x => typeof x === "number").sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------------------------------------------------------------------
// Relatório de entrega para o InterviewEvaluatorAgent
// ---------------------------------------------------------------------
// Mapeia as gravações aos turnos: usa student_audio_artifacts.turn_index
// quando preenchido (gravações novas); senão reconstrói pela ORDEM — a
// sequência de falas do aluno na conversa (intro → por turno: intervenções e
// resposta final) casa com audio_idx por construção do /chat. Se a contagem
// não bater (ex.: give_up no meio, gravação perdida), o mapeamento por ordem
// é considerado não-confiável e os tempos por gravação são omitidos.
function mapRecordingsToTurns(conversation, artifacts) {
    const byTurn = new Map(); // turn_index -> [artifacts em ordem]
    const push = (idx, a) => {
        if (!byTurn.has(idx)) byTurn.set(idx, []);
        byTurn.get(idx).push(a);
    };

    const withColumn = artifacts.filter(a => a.turn_index != null);
    if (withColumn.length === artifacts.length && artifacts.length > 0) {
        for (const a of artifacts) push(a.turn_index, a);
        return { byTurn, mappedBy: "column" };
    }

    // Reconstrução por ordem: lista de falas do aluno na ordem cronológica.
    const events = [];
    const introMsgs = Array.isArray(conversation?.intro?.messages) ? conversation.intro.messages : [];
    for (const m of introMsgs) if (m.role === "user") events.push({ turn: null });
    const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
    for (const t of turns) {
        const ivs = Array.isArray(t.interventions) ? t.interventions : [];
        for (const iv of ivs) if (iv.student_message) events.push({ turn: t.index });
        if (typeof t.answer === "string" && t.answer.trim()) events.push({ turn: t.index });
    }
    if (events.length !== artifacts.length) {
        return { byTurn, mappedBy: "unreliable" };
    }
    artifacts.forEach((a, i) => {
        if (events[i].turn != null) push(events[i].turn, a);
    });
    return { byTurn, mappedBy: "order" };
}

// Falas do aluno num turno, em ordem cronológica: a resposta à pergunta
// principal e a cada follow-up. Cada uma é uma RESPOSTA com seu próprio "tempo
// até começar a falar". O canal modal (type "meta") é lateral e não conta como
// par. A última fala é sempre a resposta final aceita (t.answer); as anteriores
// são as intervenções que dispararam follow-up/repetição/dica.
function studentUtterances(t) {
    const out = [];
    const ivs = Array.isArray(t.interventions) ? t.interventions : [];
    for (const iv of ivs) {
        if (iv.type === "meta") continue;
        if (!iv.student_message) continue;
        out.push({
            text: iv.student_message,
            ct: iv.client_timing && typeof iv.client_timing === "object" ? iv.client_timing : null,
            at: iv.at ?? null,
            dur_s: num(iv.student_audio_duration_seconds),
            isFinal: false,
        });
    }
    if (typeof t.answer === "string" && t.answer.trim()) {
        out.push({
            text: t.answer,
            ct: t.client_timing && typeof t.client_timing === "object" ? t.client_timing : null,
            at: t.answered_at ?? null,
            dur_s: num(t.answer_audio_duration_seconds),
            isFinal: true,
        });
    }
    return out;
}

/**
 * Computa métricas de forma/entrega por turno respondido. Puro (sem banco).
 *
 * @param {object} conversation   - conversation_json parseado
 * @param {Array}  audioArtifacts - linhas de student_audio_artifacts (pode ser [])
 * @returns {{mode, mapped_by, turns: Array, register_shifts: Array}}
 *   turns[i]: { index, words, chars, latency_s, cps, polish, written_register,
 *               disfluencies, recording: {duration_s, wps}|null,
 *               think_pairs: [{label, words, think_s, source}],
 *               flags: [string] }
 *   think_pairs cobre a resposta principal e cada follow-up; source "client"
 *   (medido, preciso) ou "inferido" (aproximado, só no par final de entrevistas
 *   antigas). O alerta de geração externa dispara só no preciso.
 */
export function buildDeliveryReport(conversation, audioArtifacts = []) {
    const artifacts = Array.isArray(audioArtifacts) ? audioArtifacts : [];
    const mode = artifacts.length > 0 ? "audio" : "text";
    const { byTurn, mappedBy } = mode === "audio"
        ? mapRecordingsToTurns(conversation, artifacts)
        : { byTurn: new Map(), mappedBy: "n/a" };

    const turns = (Array.isArray(conversation?.turns) ? conversation.turns : [])
        .filter(t => typeof t?.answer === "string" && t.answer.trim())
        .map(t => {
            const answer = t.answer;
            const w = words(answer);
            const chars = answer.length;
            const latency = secondsBetween(t.asked_at, t.answered_at);
            const polish = polishScore(answer);
            const wr = writtenRegisterScore(answer);
            const dis = countMatches(answer, DISFLUENCY);
            const flags = [];

            let cps = null;
            if (mode === "text" && latency != null && latency > 0) {
                cps = chars / latency;
                if (cps >= TH.PASTE_CPS && chars >= TH.PASTE_MIN_CHARS) {
                    flags.push(`${cps.toFixed(1)} caracteres/s em ${chars} caracteres — velocidade de COLAGEM (digitação humana ~3-12)`);
                }
                if (latency >= TH.LONG_LATENCY_S && w >= TH.LONG_ANSWER_WORDS && polish >= 0.4) {
                    flags.push(`${Math.round(latency)}s de espera e então resposta longa e polida (${w} palavras) — tempo compatível com consulta externa`);
                }
            }

            let recording = null;
            const thinkPairs = [];
            if (mode === "audio") {
                const utterances = studentUtterances(t);
                // Duração da gravação da RESPOSTA FINAL: cliente (precisa) >
                // campo salvo no turno > duração do artefato. Calculada antes do
                // laço porque o caminho inferido (legado) também a usa.
                const finalU = utterances.length ? utterances[utterances.length - 1] : null;
                const finalCt = finalU && finalU.ct ? finalU.ct : null;
                const recs = byTurn.get(t.index) || [];
                const finalRec = recs.length > 0 ? recs[recs.length - 1] : null;
                const finalCtDur = finalCt && num(finalCt.record_duration_ms) != null ? num(finalCt.record_duration_ms) / 1000 : null;
                const finalArtifactDur = finalRec ? num(finalRec.duration_s) : null;
                const dur = finalCtDur ?? (finalU ? finalU.dur_s : null) ?? finalArtifactDur;

                // Tempo de PENSAMENTO por par pergunta-resposta. Cada fala do
                // aluno (principal + follow-ups) tem seu próprio silêncio até
                // começar a gravar — o trecho que de fato representa "pensar
                // antes de responder". O alerta de geração externa dispara por
                // par, e SÓ no valor preciso (cliente): o inferido inclui
                // playback/rede/STT, superestima e não pode acusar.
                utterances.forEach((u, i) => {
                    const label = i === 0 ? "pergunta principal" : `follow-up ${i}`;
                    const wU = words(u.text);
                    let thinkS = null, source = null;
                    if (u.ct && num(u.ct.time_to_start_ms) != null) {
                        thinkS = Math.max(0, Math.round(num(u.ct.time_to_start_ms) / 1000));
                        source = "client";
                    } else if (u.isFinal && dur && dur > 0) {
                        // Legado (pré-instrumentação): só o par FINAL é inferido
                        // por timestamps. Aproximado — contextualiza, não acusa.
                        const ref = i > 0 ? (utterances[i - 1].at ?? t.asked_at) : t.asked_at;
                        const total = secondsBetween(ref, u.at);
                        thinkS = total != null ? Math.max(0, Math.round(total - dur)) : null;
                        if (thinkS != null) source = "inferido";
                    }
                    if (thinkS == null) return;
                    thinkPairs.push({ label, words: wU, think_s: thinkS, source });
                    if (source === "client" && thinkS >= TH.LONG_THINK_GAP_S && wU >= TH.LONG_ANSWER_WORDS) {
                        flags.push(`${label}: ${thinkS}s de silêncio antes de uma resposta de ${wU} palavras — tempo compatível com gerar fora e ler`);
                    }
                });

                if (dur && dur > 0) {
                    const wps = w / dur;
                    recording = { duration_s: Math.round(dur), wps: Number(wps.toFixed(2)) };
                    if (wps >= TH.FAST_SPEECH_WPS && w >= 25) {
                        flags.push(`${wps.toFixed(2)} palavras/s (${w} palavras em ${Math.round(dur)}s) — ritmo alto/estável, compatível com leitura`);
                    }
                }
                // Anti-gaming: abriu o microfone (gravação não-trivial) mas quase
                // não disse nada — possível "começar pra ganhar tempo".
                if (finalCt && num(finalCt.record_duration_ms) != null && num(finalCt.record_duration_ms) >= TH.STALL_OPEN_MS && w < TH.LOW_CONTENT_WORDS) {
                    flags.push(`gravou ${(num(finalCt.record_duration_ms) / 1000).toFixed(1)}s mas disse quase nada (${w} palavra(s)) — possível abrir o microfone só para "começar"`);
                }
                if (w >= 40 && dis === 0 && wr >= 0.4) {
                    flags.push(`resposta falada longa (${w} palavras) com ZERO marcador de fala espontânea e registro escrito ${wr.toFixed(2)} — compatível com leitura de texto pronto`);
                }
            }

            return {
                index: t.index,
                words: w,
                chars,
                latency_s: latency != null ? Math.round(latency) : null,
                cps: cps != null ? Number(cps.toFixed(1)) : null,
                polish: Number(polish.toFixed(2)),
                written_register: Number(wr.toFixed(2)),
                disfluencies: dis,
                recording,
                think_pairs: thinkPairs,
                flags,
            };
        });

    // Mudança de registro DENTRO do aluno: respostas muito mais polidas que a
    // própria mediana sugerem uso seletivo de ajuda externa nas difíceis.
    const medPolish = median(turns.map(t => t.polish));
    const registerShifts = [];
    for (const t of turns) {
        if (t.polish - medPolish >= 0.4 && t.polish >= 0.5) {
            registerShifts.push(`turno ${t.index}: muito mais estruturado que a mediana do próprio aluno (${t.polish.toFixed(2)} vs ${medPolish.toFixed(2)})`);
        }
    }

    return { mode, mapped_by: mappedBy, turns, register_shifts: registerShifts };
}

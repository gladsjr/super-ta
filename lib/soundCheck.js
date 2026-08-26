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

// --- Sound check GUIADO POR VOZ (#321) ---
// Roteiros do "orientador" (voz fixa, distinta do examinador — mesmo padrão do
// narrador da entrevista). FONTE ÚNICA: o gerador de áudio pré-gravado
// (scripts/gen-soundcheck-audio.mjs) sintetiza daqui, e o servidor usa o MESMO
// texto como referência do vazamento de eco (a voz-guia é a sonda: se as
// palavras do roteiro voltam pelo microfone, há eco). Mudou um roteiro →
// regere os mp3 (senão o áudio fala uma coisa e a referência é outra).
//
// VOZ CANÔNICA: "Voz C — ORATIA" do HeyGen (Cartesia, id c212c16a3ca6442cada6ac9941903ade),
// gerada pela UI do HeyGen (conta do Gladstone; o plano não tem créditos de API).
// Na locução, grafar "Orátia" (e "iá") p/ pronúncia — aqui fica a grafia da marca,
// que é a exibida na legenda. SC_VOICE ("sage", OpenAI) é só o fallback do
// gerador automático scripts/gen-soundcheck-audio.mjs.
export const SC_VOICE = "sage";
export const SC_SCRIPTS = {
    g1_intro: "Olá! Eu sou a orientação automática da ORATIA. Antes de começar, vou fazer alguns testes rápidos para garantir que a sua fala será entendida sem erros. Primeiro: fique em silêncio por alguns segundos, enquanto eu meço o ambiente e a conexão.",
    g2_ok: "Conexão e nível de ruído: tudo certo.",
    g2_conn: "A sua conexão está instável ou lenta. Você pode continuar, mas pode haver cortes — se puder, aproxime-se do roteador ou troque de rede. Clique em Estou ciente para seguir.",
    g2_ruido: "O ambiente está barulhento. Você pode continuar, mas o ruído atrapalha a transcrição da sua fala — se puder, procure um lugar mais silencioso. Clique em Estou ciente para seguir.",
    g3_fones: "Para a prova, é obrigatório usar fones de ouvido. Sem eles, a minha voz volta pelo seu microfone e vira eco. Coloque os fones agora, marque a caixa confirmando, e clique em Testar captação.",
    g4_eco: "Detectei eco: a minha voz está voltando pelo seu microfone. Isso normalmente acontece sem fones de ouvido, ou com o volume muito alto. Este ponto é bloqueante: ajuste o equipamento, e vamos tentar de novo.",
    g5_eco_loop: "Para garantir a qualidade da avaliação, preciso de som sem eco. Use fones de ouvido e baixe o volume. Se eu detectar eco de novo, voltaremos a este mesmo estágio.",
    g6_leitura: "Agora, leia em voz alta a frase que está na tela, com a mesma entonação que você vai usar na prova. O objetivo é garantir uma boa transcrição dos termos específicos do tema. Clique em Gravar, leia a frase, e clique em Parar e verificar.",
    g7_leitura_ruim: "A captação da sua leitura não ficou boa. Fale um pouco mais perto do microfone, num ritmo tranquilo, e tente novamente.",
    g8_fim: "Tudo certo por aqui. Pode continuar para a próxima etapa.",
};

// Stopwords pt-BR para o vazamento por roteiro: palavras funcionais comuns não
// denunciam eco (apareceriam em fala legítima); só palavras DISTINTIVAS contam.
const LEAK_STOP = new Set(["para", "porque", "quando", "enquanto", "antes", "depois", "agora", "muito", "pode", "puder", "clique", "estou", "vamos", "tentar", "alguns", "segundos", "primeiro", "sobre", "como", "isso", "este", "esta", "pelo", "pela", "meu", "minha", "você", "voce", "ficar", "fique"]);

// Quantas palavras DISTINTIVAS (≥5 letras, fora de stopwords) do roteiro
// aparecem na transcrição do microfone. ≥ SCRIPT_LEAK_MIN = vazamento.
export const SCRIPT_LEAK_MIN = 3;
export function scriptLeakMatches(transcript, scriptText) {
    const heard = new Set(normalize(transcript).split(" ").filter(Boolean));
    const ref = new Set(normalize(scriptText).split(" ").filter(w => w.length >= 5 && !LEAK_STOP.has(w)));
    let n = 0;
    for (const w of ref) if (heard.has(w)) n++;
    return n;
}

// Progresso das etapas p/ o wizard reentrar no estágio certo após reload.
export function soundCheckProgress(c, maxAttempts = 2) {
    return {
        leitura_done: c?.passed === true || Number(c?.attempts) >= maxAttempts,
        echo_done: Number(c?.echo?.tests) > 0 && !(c?.echo?.leaks_recent || []).slice(-1)[0],
    };
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

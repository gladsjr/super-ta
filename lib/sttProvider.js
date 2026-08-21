// Camada de PROVEDOR de STT (issue #284, Fase 1 da estratégia de transcrição).
//
// Uma interface única para transcrever fala, com:
//   - seleção de provedor por config (policy.yaml#models.stt_provider);
//   - FALLBACK automático por chamada: primário falhou/estourou o timeout →
//     secundário transparente (o pior caso custa o preço do provedor atual,
//     nunca prova travada);
//   - metering fail-fast: todo provedor CONFIGURADO precisa de preço em
//     pricing.yaml e de credencial no ambiente — sem isso o boot cai
//     (ADR 0002; lição do metering realtime zerado);
//   - sombra (shadow) opcional: uma fração das chamadas roda TAMBÉM no
//     provedor sombra, só para comparação de qualidade nos logs — nunca
//     afeta o texto devolvido ao chamador.
//
// SEM mudança de comportamento com a config padrão (openai, sem fallback,
// sem sombra): o caminho é idêntico ao transcribeAudio de sempre.
//
// Provedores:
//   openai — gpt-transcribe via o CLIENTE PASSADO pelo chamador (preserva o
//            roteamento por trabalho de benchmark, lib/openaiClient.js).
//   groq   — whisper-large-v3 na API da Groq (endpoint compatível com OpenAI).
//            language=pt fixo (previne troca de idioma da frase inteira) +
//            `prompt` com o vocabulário do trabalho (glossário — corrige
//            grafia de termo raro; a disciplina antiviés vale: vocabulário
//            corrige grafia, não induz conteúdo) + verbose_json (traz
//            avg_logprob/no_speech_prob por segmento — sinais de qualidade
//            que o gpt-transcribe não dá; insumo do monitor #287).

import OpenAI from "openai";
import { transcribeAudio } from "./audio.js";
import { meteredStt } from "./billing.js";
import log from "./logger.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Cliente Groq (lazy): criado na primeira chamada. A EXISTÊNCIA da credencial
// é validada no boot por assertProviderReady quando o provedor está
// configurado — aqui só materializa.
let _groqClient = null;
function groqClient() {
    if (!_groqClient) {
        _groqClient = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
    }
    return _groqClient;
}

// Valida um provedor CONFIGURADO no boot (chamado por lib/config.js).
// Devolve o modelo que o provedor usa — entra no validatePricingCoverage.
export function assertProviderReady(provider, { groqModel } = {}) {
    if (provider === "openai") return null; // modelo/credencial já validados pelo caminho existente
    if (provider === "groq") {
        if (!process.env.GROQ_API_KEY) {
            throw new Error(`models.stt: provedor "groq" configurado mas GROQ_API_KEY ausente no ambiente`);
        }
        if (!groqModel) throw new Error(`models.stt: provedor "groq" configurado sem stt_groq_model`);
        return groqModel;
    }
    throw new Error(`models.stt: provedor desconhecido "${provider}" (use openai|groq)`);
}

// --- Motores por provedor -------------------------------------------------
// Cada motor devolve { text, usage, logprobs, quality, provider, model }.
// `usage` no formato que computeSttCost entende; `quality` são os sinais por
// segmento quando o provedor os dá (whisper), null quando não (gpt-transcribe).

async function engineOpenai({ openaiClient, sttModel, buffer, filename, keywords }) {
    const r = await transcribeAudio(openaiClient, sttModel, buffer, filename, { keywords });
    return { ...r, quality: null, provider: "openai", model: sttModel };
}

async function engineGroq({ groqModel, buffer, filename, keywords }) {
    const file = await OpenAI.toFile(buffer, filename);
    const params = {
        model: groqModel,
        file,
        language: "pt",
        temperature: 0,
        // verbose_json: segmentos com avg_logprob/no_speech_prob/compression_ratio.
        response_format: "verbose_json",
    };
    if (Array.isArray(keywords) && keywords.length > 0) {
        // O `prompt` do whisper ancora grafia de termos de domínio (~224 tokens).
        params.prompt = keywords.join(", ");
    }
    const response = await log.span("AUDIO:STT", `groq ${groqModel}`, () =>
        groqClient().audio.transcriptions.create(params)
    );
    const text = (response?.text || "").trim();
    if (!text) throw new Error("sttProvider(groq): empty transcription");
    const segments = Array.isArray(response?.segments) ? response.segments : null;
    const quality = segments
        ? segments.map(s => ({
            start: s.start, end: s.end,
            avg_logprob: s.avg_logprob, no_speech_prob: s.no_speech_prob,
            compression_ratio: s.compression_ratio,
        }))
        : null;
    // O whisper/Groq devolve `duration` (segundos) em vez do usage da OpenAI —
    // sintetizamos o formato que computeSttCost entende (cobrança por duração).
    const seconds = Number(response?.duration ?? 0);
    const usage = seconds > 0 ? { type: "duration", seconds } : undefined;
    log.info("AUDIO:STT", `groq ok segs=${segments ? segments.length : "—"} ${log.preview(text, 120)}`);
    return { text, usage, logprobs: null, quality, provider: "groq", model: groqModel };
}

// --- Decisão de fallback (pura, testável) ---------------------------------
// Monta o plano de tentativas: [primário] ou [primário, fallback]. Fallback
// igual ao primário é ignorado (não faz sentido re-tentar no mesmo lugar —
// retry de rede fica a cargo do SDK).
export function attemptPlan({ provider, fallbackProvider }) {
    const plan = [provider];
    if (fallbackProvider && fallbackProvider !== provider) plan.push(fallbackProvider);
    return plan;
}

// Timeout só faz sentido quando há para onde cair: sem fallback, esperar o
// SDK é melhor que desistir (comportamento histórico preservado).
export function effectiveTimeoutMs({ plan, timeoutMs }) {
    return plan.length > 1 && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
}

function withTimeout(promise, ms, label) {
    if (!ms) return promise;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label}: timeout após ${ms}ms`)), ms);
        promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

// --- Comparação p/ sombra (pura, testável) --------------------------------
// WER simples palavra-a-palavra (distância de edição / palavras da referência).
// Serve só para o LOG de comparação da sombra — não é métrica de avaliação.
export function simpleWer(reference, hypothesis) {
    const norm = s => String(s || "").toLowerCase().normalize("NFC")
        .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    const a = norm(reference), b = norm(hypothesis);
    if (!a.length) return b.length ? 1 : 0;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return Math.round((dp[a.length][b.length] / a.length) * 1000) / 1000;
}

// --- API principal ---------------------------------------------------------
// cfg (via lib/config.js): { provider, fallbackProvider, sttModel, groqModel,
//                            timeoutMs, shadowProvider, shadowRate }
// call: { openaiClient, buffer, filename, keywords, meterCtx }
//   meterCtx { workId, submissionId? } — quando presente, CADA tentativa é
//   medida com o modelo REALMENTE usado (fallback não pode faturar como se
//   fosse o primário). Ausente = sem metering (calibração hoje não fatura;
//   comportamento preservado).
// _engines: injeção para teste.
export async function transcribe(cfg, call, _engines = { openai: engineOpenai, groq: engineGroq }) {
    const plan = attemptPlan(cfg);
    const timeout = effectiveTimeoutMs({ plan, timeoutMs: cfg.timeoutMs });
    let lastErr = null;
    let result = null;
    for (let i = 0; i < plan.length; i++) {
        const provider = plan[i];
        const engine = _engines[provider];
        const model = provider === "groq" ? cfg.groqModel : cfg.sttModel;
        const run = () => engine({
            openaiClient: call.openaiClient, sttModel: cfg.sttModel, groqModel: cfg.groqModel,
            buffer: call.buffer, filename: call.filename, keywords: call.keywords,
        });
        try {
            const attempt = () => withTimeout(run(), timeout, `stt(${provider})`);
            result = call.meterCtx
                ? await meteredStt({ ...call.meterCtx, model }, attempt)
                : await attempt();
            if (i > 0) log.warn("AUDIO:STT", `fallback usado: ${plan[0]} → ${provider}`);
            break;
        } catch (err) {
            lastErr = err;
            log.error("AUDIO:STT", `provedor ${provider} falhou: ${err.message}${i < plan.length - 1 ? " — tentando fallback" : ""}`);
        }
    }
    if (!result) throw lastErr || new Error("sttProvider: sem provedor disponível");

    // Sombra: fração das chamadas roda também no provedor sombra, async, só
    // para o log de comparação. Nunca altera o resultado; erro é engolido
    // (com log). Custo da sombra é medido também (faturamento honesto).
    if (cfg.shadowProvider && cfg.shadowProvider !== result.provider && Math.random() < (cfg.shadowRate ?? 0)) {
        const model = cfg.shadowProvider === "groq" ? cfg.groqModel : cfg.sttModel;
        const engine = _engines[cfg.shadowProvider];
        const run = () => engine({
            openaiClient: call.openaiClient, sttModel: cfg.sttModel, groqModel: cfg.groqModel,
            buffer: call.buffer, filename: call.filename, keywords: call.keywords,
        });
        (call.meterCtx ? meteredStt({ ...call.meterCtx, model }, run) : run())
            .then(shadow => {
                const wer = simpleWer(result.text, shadow.text);
                log.info("AUDIO:STT", `SHADOW ${result.provider}→${cfg.shadowProvider} wer=${wer} len=${result.text.length}/${shadow.text.length}`);
            })
            .catch(err => log.warn("AUDIO:STT", `SHADOW ${cfg.shadowProvider} falhou: ${err.message}`));
    }
    return result;
}

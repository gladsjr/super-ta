// Source-of-truth para configuração de runtime.
//
// - `policy` lê config/policy.yaml e expõe os 4 modelos + threshold de triagem.
//   Fail-fast no boot se qualquer campo obrigatório faltar.
// - `pricing` é validado no boot via validatePricingCoverage().
// - Constantes de orquestração (cap do intro, cap de skips, total de perguntas)
//   ficam aqui também — são números fixos hoje, futuramente configuráveis.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import {
    loadPricing,
    validatePricingCoverage,
    getDefaultWorkBudgetUsd,
} from "./billing.js";
import log from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(PROJECT_ROOT, "config");

export function loadPolicy() {
    const policyText = fs.readFileSync(path.join(CONFIG_DIR, "policy.yaml"), "utf-8");
    return yaml.load(policyText) || {};
}

const policy = loadPolicy();

function requireString(value, name) {
    if (!value || typeof value !== "string") {
        throw new Error(`config/policy.yaml must define ${name}`);
    }
    return value;
}

export const PRINCIPAL_REASONING_MODEL = requireString(policy?.models?.principal_reasoning_model, "models.principal_reasoning_model");
// Esforço de raciocínio do modelo principal. Opcional: ausente/vazio = null (usa o
// padrão do modelo). Se presente, fail-fast se inválido. Aplicado em openaiClient.
const _effort = policy?.models?.principal_reasoning_effort;
if (_effort != null && _effort !== "" && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(_effort)) {
    throw new Error(`config/policy.yaml models.principal_reasoning_effort inválido: "${_effort}" (use none|minimal|low|medium|high|xhigh|max ou remova)`);
}
export const PRINCIPAL_REASONING_EFFORT = (_effort == null || _effort === "") ? null : _effort;
export const FAST_MODEL = requireString(policy?.models?.fast_model, "models.fast_model");
export const STT_MODEL = requireString(policy?.models?.stt_model, "models.stt_model");
export const TTS_MODEL = requireString(policy?.models?.tts_model, "models.tts_model");
// Modelo Realtime (fala-a-fala) — usado só pelo tipo de trabalho "prova oral".
export const REALTIME_MODEL = requireString(policy?.models?.realtime_model, "models.realtime_model");
export const TRIAGE_THRESHOLD = Number(policy?.triage?.intensity_threshold ?? 6);
// Breakpoints explícitos de cache de prompt (5.6+). Ver comentário em policy.yaml.
export const PROMPT_CACHE_EXPLICIT = policy?.prompt_cache?.explicit_breakpoints === true;
// Dedup: blocos estáveis do orquestrador nas instructions (não no input por turno).
export const PROMPT_STATIC_IN_INSTRUCTIONS = policy?.prompt_cache?.static_blocks_in_instructions === true;
// Keep-alive do cache entre turnos, em segundos (0/ausente = desligado).
export const PROMPT_CACHE_KEEPALIVE_SEC = Math.max(0, Math.floor(Number(policy?.prompt_cache?.keepalive_seconds ?? 0)));

// Pré-gate de inteligibilidade (modo áudio). Bloco inteiro é exposto porque o
// detector (lib/audioIntelligibility.js) consome múltiplos campos juntos.
// Defaults conservadores em código se o bloco estiver ausente.
const _aiPol = policy?.audio_intelligibility ?? {};
export const AUDIO_INTELLIGIBILITY = {
    enabled: _aiPol.enabled !== false,
    warn_logprob_threshold: Number(_aiPol.warn_logprob_threshold ?? -0.69),
    warn_pct: Number(_aiPol.warn_pct ?? 0.05),
    repeat_logprob_threshold: Number(_aiPol.repeat_logprob_threshold ?? -1.2),
    repeat_consecutive: Math.max(1, Math.floor(Number(_aiPol.repeat_consecutive ?? 8))),
    repeat_pct: Number(_aiPol.repeat_pct ?? 0.35),
    min_utterance_tokens: Math.max(0, Math.floor(Number(_aiPol.min_utterance_tokens ?? 4))),
    max_retries_before_give_up: Math.max(1, Math.floor(Number(_aiPol.max_retries_before_give_up ?? 3))),
};

// Camada ACÚSTICA (modo áudio). Métricas calculadas no navegador (PCM do mic) e
// reportadas no upload; mapeadas a tiers e combinadas por severidade-máxima com
// o gate de logprob (lib/acousticGate.js). Defaults conservadores se faltar.
const _acPol = policy?.acoustic ?? {};
export const ACOUSTIC = {
    enabled: _acPol.enabled !== false,
    snr_enabled: _acPol.snr_enabled !== false,
    snr_warn: Number(_acPol.snr_warn ?? 20),
    snr_repeat: Number(_acPol.snr_repeat ?? 12),
    bak_enabled: _acPol.bak_enabled === true,
    bak_warn: Number(_acPol.bak_warn ?? 2.5),
    bak_repeat: Number(_acPol.bak_repeat ?? 1.6),
};

log.info("CONFIG", `principal_reasoning_model=${PRINCIPAL_REASONING_MODEL}${PRINCIPAL_REASONING_EFFORT ? `(effort=${PRINCIPAL_REASONING_EFFORT})` : ""} fast_model=${FAST_MODEL} stt_model=${STT_MODEL} tts_model=${TTS_MODEL} triage_threshold=${TRIAGE_THRESHOLD}`);
log.info("CONFIG", `audio_intelligibility enabled=${AUDIO_INTELLIGIBILITY.enabled} warn=${AUDIO_INTELLIGIBILITY.warn_logprob_threshold}/${AUDIO_INTELLIGIBILITY.warn_pct} repeat=${AUDIO_INTELLIGIBILITY.repeat_logprob_threshold}/run${AUDIO_INTELLIGIBILITY.repeat_consecutive}/pct${AUDIO_INTELLIGIBILITY.repeat_pct} M=${AUDIO_INTELLIGIBILITY.min_utterance_tokens} N=${AUDIO_INTELLIGIBILITY.max_retries_before_give_up}`);
log.info("CONFIG", `acoustic enabled=${ACOUSTIC.enabled} snr=${ACOUSTIC.snr_enabled ? `${ACOUSTIC.snr_warn}/${ACOUSTIC.snr_repeat}` : "off"} bak=${ACOUSTIC.bak_enabled ? `${ACOUSTIC.bak_warn}/${ACOUSTIC.bak_repeat}` : "off"}`);

// Pricing: fonte única em config/pricing.yaml. Fail-fast se algum modelo
// declarado em policy.yaml não tiver entrada de preço.
loadPricing();
validatePricingCoverage({
    textModels: [PRINCIPAL_REASONING_MODEL, FAST_MODEL],
    sttModels: [STT_MODEL],
    ttsModels: [TTS_MODEL],
});

export const DEFAULT_WORK_BUDGET_USD = getDefaultWorkBudgetUsd();
log.info("CONFIG", `default_work_budget_usd=$${DEFAULT_WORK_BUDGET_USD.toFixed(2)}`);

export const PORT = process.env.PORT || 5000;

// Número de perguntas planejadas. Antes fixo (10); agora configurável por
// trabalho em works.question_count. Estas constantes são a fonte única de
// default e faixa válida — espelham o papel de config/voices.js#isValidVoice.
// A CHECK constraint em migrations/010 reforça os mesmos limites no banco.
export const DEFAULT_QUESTION_COUNT = 6;
export const MIN_QUESTION_COUNT = 3;
export const MAX_QUESTION_COUNT = 20;
export function isValidQuestionCount(n) {
    return Number.isInteger(n) && n >= MIN_QUESTION_COUNT && n <= MAX_QUESTION_COUNT;
}

// Constantes de orquestração — fixas hoje, futuramente configuráveis.
export const INTRO_TURN_CAP = 3;
// Cap em skips consecutivos da relevance — com plano de 10 perguntas, deixa
// folga; se chegar no cap, loga e força a próxima pergunta.
export const MAX_RELEVANCE_SKIPS = 8;

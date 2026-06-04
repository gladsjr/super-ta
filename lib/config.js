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
export const FAST_MODEL = requireString(policy?.models?.fast_model, "models.fast_model");
export const STT_MODEL = requireString(policy?.models?.stt_model, "models.stt_model");
export const TTS_MODEL = requireString(policy?.models?.tts_model, "models.tts_model");
export const TRIAGE_THRESHOLD = Number(policy?.triage?.intensity_threshold ?? 6);

// Pré-gate de inteligibilidade (modo áudio). Bloco inteiro é exposto porque o
// detector (lib/audioIntelligibility.js) consome múltiplos campos juntos.
// Defaults conservadores em código se o bloco estiver ausente.
const _aiPol = policy?.audio_intelligibility ?? {};
export const AUDIO_INTELLIGIBILITY = {
    enabled: _aiPol.enabled !== false,
    low_logprob_threshold: Number(_aiPol.low_logprob_threshold ?? -1.0),
    min_consecutive_low_tokens: Math.max(1, Math.floor(Number(_aiPol.min_consecutive_low_tokens ?? 3))),
    min_utterance_tokens: Math.max(0, Math.floor(Number(_aiPol.min_utterance_tokens ?? 6))),
    max_retries_before_give_up: Math.max(1, Math.floor(Number(_aiPol.max_retries_before_give_up ?? 3))),
};

log.info("CONFIG", `principal_reasoning_model=${PRINCIPAL_REASONING_MODEL} fast_model=${FAST_MODEL} stt_model=${STT_MODEL} tts_model=${TTS_MODEL} triage_threshold=${TRIAGE_THRESHOLD}`);
log.info("CONFIG", `audio_intelligibility enabled=${AUDIO_INTELLIGIBILITY.enabled} T=${AUDIO_INTELLIGIBILITY.low_logprob_threshold} K=${AUDIO_INTELLIGIBILITY.min_consecutive_low_tokens} M=${AUDIO_INTELLIGIBILITY.min_utterance_tokens} N=${AUDIO_INTELLIGIBILITY.max_retries_before_give_up}`);

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

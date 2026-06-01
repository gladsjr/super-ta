// Cost tracking per work_token.
//
// Princípios (ver CLAUDE.md / replit.md):
// - Fonte única de preços: config/pricing.yaml. Fail-fast no boot se um modelo
//   declarado em policy.yaml não estiver listado aqui.
// - A OpenAI NÃO retorna custo em USD. Calculamos a partir de `usage` (token
//   counts) × tabela de preços local. TTS não retorna usage; estimamos pelos
//   caracteres de input.
// - Cada chamada que incorre custo passa por `metered(...)`. O wrapper roda a
//   função, lê o usage da resposta, calcula o custo, debita no banco
//   (INSERT em work_cost_events + UPDATE works.spent_usd em transação) e
//   devolve a resposta intocada.
// - `isWorkBudgetExceeded` é a checagem pré-flight: chamadas devem ser
//   bloqueadas no caller quando ela retorna true.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { pool } from "../auth.js";
import log from "./logger.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(LIB_DIR, "..");

let pricing = null;

export function loadPricing() {
    const pricingPath = path.join(PROJECT_ROOT, "config", "pricing.yaml");
    const text = fs.readFileSync(pricingPath, "utf-8");
    const data = yaml.load(text) || {};
    if (typeof data.default_work_budget_usd !== "number" || data.default_work_budget_usd < 0) {
        throw new Error("config/pricing.yaml must define default_work_budget_usd (number >= 0)");
    }
    if (!data.text || typeof data.text !== "object") {
        throw new Error("config/pricing.yaml must define text: { <model>: {...} }");
    }
    if (!data.stt || typeof data.stt !== "object") {
        throw new Error("config/pricing.yaml must define stt: { <model>: {...} }");
    }
    if (!data.tts || typeof data.tts !== "object") {
        throw new Error("config/pricing.yaml must define tts: { <model>: {...} }");
    }
    pricing = data;
    return data;
}

export function getDefaultWorkBudgetUsd() {
    if (!pricing) throw new Error("billing: pricing not loaded; call loadPricing() at boot");
    return pricing.default_work_budget_usd;
}

// Garante que todo modelo usado pelo sistema tem entrada em pricing.yaml.
// Chamada no boot, depois de loadPolicy() + loadPricing().
export function validatePricingCoverage({ textModels, sttModels, ttsModels }) {
    if (!pricing) throw new Error("billing: pricing not loaded");
    const missing = [];
    for (const m of textModels) if (!pricing.text?.[m]) missing.push(`text.${m}`);
    for (const m of sttModels) if (!pricing.stt?.[m]) missing.push(`stt.${m}`);
    for (const m of ttsModels) if (!pricing.tts?.[m]) missing.push(`tts.${m}`);
    if (missing.length > 0) {
        throw new Error(`config/pricing.yaml missing entries for: ${missing.join(", ")}`);
    }
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

function priceOrThrow(category, model) {
    const entry = pricing?.[category]?.[model];
    if (!entry) throw new Error(`billing: no ${category} pricing for model "${model}"`);
    return entry;
}

// usage: ResponseUsage do Responses API.
// Retorna { cost_usd, input_tokens, cached_tokens, output_tokens }
export function computeResponsesCost(usage, model) {
    const p = priceOrThrow("text", model);
    const input = Number(usage?.input_tokens ?? 0);
    const cached = Number(usage?.input_tokens_details?.cached_tokens ?? 0);
    const output = Number(usage?.output_tokens ?? 0);
    const billable_input = Math.max(0, input - cached);
    const cost =
        (billable_input * p.input_per_mtok) / 1_000_000 +
        (cached * p.input_cached_per_mtok) / 1_000_000 +
        (output * p.output_per_mtok) / 1_000_000;
    return { cost_usd: cost, input_tokens: input, cached_tokens: cached, output_tokens: output };
}

// usage: Transcription.usage (Tokens | Duration | undefined).
// Retorna { cost_usd, input_tokens, output_tokens, audio_seconds }
export function computeSttCost(usage, model) {
    const p = priceOrThrow("stt", model);
    if (usage?.type === "tokens") {
        const input = Number(usage.input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        const cost =
            (input * p.input_per_mtok) / 1_000_000 +
            (output * p.output_per_mtok) / 1_000_000;
        return { cost_usd: cost, input_tokens: input, output_tokens: output, audio_seconds: null };
    }
    if (usage?.type === "duration") {
        const seconds = Number(usage.seconds ?? 0);
        const cost = seconds * p.per_second_usd;
        return { cost_usd: cost, input_tokens: null, output_tokens: null, audio_seconds: seconds };
    }
    // Sem usage — estimar por duração desconhecida é arriscado. Cobramos zero
    // e logamos warning. Em produção, podemos endurecer para fail-fast.
    log.warn("BILLING", `STT response without usage (model=${model}); cost=0`);
    return { cost_usd: 0, input_tokens: null, output_tokens: null, audio_seconds: null };
}

// TTS: API não devolve usage. Cobramos por caractere de input.
// Retorna { cost_usd, audio_chars }
export function computeTtsCost(inputText, model) {
    const p = priceOrThrow("tts", model);
    const chars = String(inputText ?? "").length;
    const cost = (chars * p.text_per_mchar) / 1_000_000;
    return { cost_usd: cost, audio_chars: chars };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// Insere evento e atualiza spent_usd atomicamente. workId pode ser null se a
// chamada acontece fora de um contexto de work (não cobramos nesse caso).
async function recordCost({
    workId,
    submissionId = null,
    eventType,         // 'responses' | 'tts' | 'stt'
    model,
    agentLabel = null,
    inputTokens = null,
    cachedTokens = null,
    outputTokens = null,
    audioSeconds = null,
    audioChars = null,
    costUsd,
}) {
    if (!workId) {
        log.warn("BILLING", `cost without workId (event=${eventType} model=${model} cost=$${costUsd.toFixed(6)})`);
        return;
    }
    if (!Number.isFinite(costUsd) || costUsd < 0) {
        log.error("BILLING", `invalid cost ${costUsd} (event=${eventType} model=${model})`);
        return;
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `INSERT INTO work_cost_events (
                work_id, submission_id, event_type, model, agent_label,
                input_tokens, cached_tokens, output_tokens,
                audio_seconds, audio_chars, cost_usd
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
                workId, submissionId, eventType, model, agentLabel,
                inputTokens, cachedTokens, outputTokens,
                audioSeconds, audioChars, costUsd,
            ]
        );
        await client.query(
            `UPDATE works SET spent_usd = spent_usd + $1, updated_at = now() WHERE id = $2`,
            [costUsd, workId]
        );
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => { });
        log.error("BILLING", `recordCost failed: ${err.message}`);
        // Não propagamos: contabilidade não deve quebrar a operação de negócio.
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

// Envolve um responses.create. ctx: { workId, submissionId?, agentLabel, model }
//
// Modo non-stream: `fn()` resolve para uma Response com `.usage` populado;
// lemos imediatamente e gravamos.
//
// Modo stream (payload.stream === true): `fn()` resolve para um Stream
// (async iterable). O `.usage` só chega no evento `response.completed`
// no FIM do stream. Embrulhamos o stream num async generator que repassa
// todos os eventos para o caller, captura o usage final, e grava o custo
// no `finally` (depois da última iteração ou em caso de erro/abort).
export async function meteredResponses(ctx, fn) {
    const response = await fn();

    // Detecta stream: async iterable. Response non-stream é objeto plano.
    const isStream = response != null && typeof response[Symbol.asyncIterator] === "function";

    if (isStream) {
        return (async function* meteredStream() {
            let finalUsage = null;
            try {
                for await (const event of response) {
                    if (event?.type === "response.completed") {
                        finalUsage = event.response?.usage ?? finalUsage;
                    }
                    yield event;
                }
            } finally {
                try {
                    const { cost_usd, input_tokens, cached_tokens, output_tokens } =
                        computeResponsesCost(finalUsage, ctx.model);
                    log.info("BILLING", `${ctx.agentLabel || "responses"}[stream] model=${ctx.model} in=${input_tokens} cached=${cached_tokens} out=${output_tokens} cost=$${cost_usd.toFixed(6)}`);
                    await recordCost({
                        workId: ctx.workId,
                        submissionId: ctx.submissionId,
                        eventType: "responses",
                        model: ctx.model,
                        agentLabel: ctx.agentLabel || null,
                        inputTokens: input_tokens,
                        cachedTokens: cached_tokens,
                        outputTokens: output_tokens,
                        costUsd: cost_usd,
                    });
                } catch (err) {
                    log.error("BILLING", `meteredResponses[stream] cost calc failed: ${err.message}`);
                }
            }
        })();
    }

    try {
        const { cost_usd, input_tokens, cached_tokens, output_tokens } =
            computeResponsesCost(response?.usage, ctx.model);
        log.info("BILLING", `${ctx.agentLabel || "responses"} model=${ctx.model} in=${input_tokens} cached=${cached_tokens} out=${output_tokens} cost=$${cost_usd.toFixed(6)}`);
        await recordCost({
            workId: ctx.workId,
            submissionId: ctx.submissionId,
            eventType: "responses",
            model: ctx.model,
            agentLabel: ctx.agentLabel || null,
            inputTokens: input_tokens,
            cachedTokens: cached_tokens,
            outputTokens: output_tokens,
            costUsd: cost_usd,
        });
    } catch (err) {
        log.error("BILLING", `meteredResponses cost calc failed: ${err.message}`);
    }
    return response;
}

// Envolve um audio.transcriptions.create.
// ctx: { workId, submissionId?, model }
export async function meteredStt(ctx, fn) {
    const response = await fn();
    try {
        const { cost_usd, input_tokens, output_tokens, audio_seconds } =
            computeSttCost(response?.usage, ctx.model);
        log.info("BILLING", `STT model=${ctx.model} in=${input_tokens ?? "-"} out=${output_tokens ?? "-"} sec=${audio_seconds ?? "-"} cost=$${cost_usd.toFixed(6)}`);
        await recordCost({
            workId: ctx.workId,
            submissionId: ctx.submissionId,
            eventType: "stt",
            model: ctx.model,
            inputTokens: input_tokens,
            outputTokens: output_tokens,
            audioSeconds: audio_seconds,
            costUsd: cost_usd,
        });
    } catch (err) {
        log.error("BILLING", `meteredStt cost calc failed: ${err.message}`);
    }
    return response;
}

// Envolve um audio.speech.create. Cobra pelos caracteres de inputText.
// ctx: { workId, submissionId?, model, inputText }
export async function meteredTts(ctx, fn) {
    const response = await fn();
    try {
        const { cost_usd, audio_chars } = computeTtsCost(ctx.inputText, ctx.model);
        log.info("BILLING", `TTS model=${ctx.model} chars=${audio_chars} cost=$${cost_usd.toFixed(6)}`);
        await recordCost({
            workId: ctx.workId,
            submissionId: ctx.submissionId,
            eventType: "tts",
            model: ctx.model,
            audioChars: audio_chars,
            costUsd: cost_usd,
        });
    } catch (err) {
        log.error("BILLING", `meteredTts cost calc failed: ${err.message}`);
    }
    return response;
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

export async function getWorkBalance(workId) {
    const r = await pool.query(
        `SELECT budget_usd::float8 AS budget, spent_usd::float8 AS spent FROM works WHERE id = $1`,
        [workId]
    );
    if (r.rowCount === 0) return null;
    const { budget, spent } = r.rows[0];
    const remaining = Math.max(0, budget - spent);
    const percent_used = budget > 0 ? Math.min(100, (spent / budget) * 100) : 100;
    return { budget_usd: budget, spent_usd: spent, remaining_usd: remaining, percent_used };
}

export async function isWorkBudgetExceeded(workId) {
    const balance = await getWorkBalance(workId);
    if (!balance) return true;     // work não existe → bloqueia
    return balance.spent_usd >= balance.budget_usd;
}

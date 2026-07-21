// Auditoria de custo: reconcilia o custo CALCULADO localmente (work_cost_events,
// tokens × config/pricing.yaml) contra o consumo REAL reportado pela OpenAI.
//
// Duas fontes na OpenAI (Admin key, nível ORGANIZAÇÃO):
//   - Usage API  (/v1/organization/usage/*): tokens/segundos/caracteres por
//     modelo, filtráveis por api_key_id. É a fonte PRECISA por-benchmark quando
//     a chave de benchmark vive no MESMO projeto de produção (a decisão atual):
//     filtramos pela chave dedicada (BENCHMARK_OPENAI_API_KEY_ID). Atualiza em
//     ~minutos/horas.
//   - Costs API  (/v1/organization/costs): US$ FATURADO, agrupável só por
//     project_id/line_item (NÃO por api_key). No mesmo projeto ela NÃO separa
//     benchmark de produção → serve de cross-check no nível projeto/dia. Fecha
//     ~no dia seguinte.
//
// Estratégia (mesmo projeto): o US$ preciso do benchmark = tokens_reais(Usage) ×
// pricing.yaml (reference_usd). A Costs projeto/dia é teto/sanidade. Para US$
// FATURADO limpo do benchmark, mover a chave para um projeto dedicado e usar a
// Costs com group_by=project_id (upgrade opcional).
//
// Divergências ESPERADAS (é o valor da auditoria): TTS estimado por char, STT
// sem usage → custo 0 local, realtime pode superestimar input. Ver lib/billing.js.

import { loadPricing } from "./billing.js";
import log from "./logger.js";

const USAGE_BASE = "https://api.openai.com/v1/organization/usage";
const COSTS_URL = "https://api.openai.com/v1/organization/costs";

function requireAdminKey() {
    const k = process.env.OPENAI_ADMIN_KEY;
    if (!k) throw new Error("OPENAI_ADMIN_KEY ausente — a auditoria de custo usa a Admin key da organização (Usage/Costs API); defina-a no .env");
    return k;
}

// api_key_id da chave de benchmark, para filtrar a Usage API. Sem ele, a Usage
// não consegue isolar o benchmark da produção (quando a chave vive no mesmo projeto).
function benchmarkApiKeyId() {
    return process.env.BENCHMARK_OPENAI_API_KEY_ID || null;
}

// project_id do projeto DEDICADO de benchmark. Quando presente, a Costs API
// filtrada por ele devolve o US$ FATURADO limpo do benchmark (sem a produção) —
// e a Usage também é escopada ao projeto (cinto e suspensório com o api_key_id).
function benchmarkProjectId() {
    return process.env.BENCHMARK_OPENAI_PROJECT_ID || null;
}

// ---------------------------------------------------------------------------
// IO — Usage / Costs API (paginação)
// ---------------------------------------------------------------------------

async function fetchUsageBuckets(endpoint, { startTime, endTime, bucketWidth = "1d", groupBy = ["model"], apiKeyIds = null, projectIds = null }) {
    const adminKey = requireAdminKey();
    const buckets = [];
    let page = null;
    let guard = 0;
    do {
        const url = new URL(`${USAGE_BASE}/${endpoint}`);
        url.searchParams.set("start_time", String(startTime));
        url.searchParams.set("end_time", String(endTime));
        url.searchParams.set("bucket_width", bucketWidth);
        for (const g of groupBy) url.searchParams.append("group_by[]", g);
        if (apiKeyIds && apiKeyIds.length) for (const id of apiKeyIds) url.searchParams.append("api_key_ids[]", id);
        if (projectIds && projectIds.length) for (const id of projectIds) url.searchParams.append("project_ids[]", id);
        url.searchParams.set("limit", "31");
        if (page) url.searchParams.set("page", page);
        const r = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } });
        if (!r.ok) throw new Error(`Usage API ${endpoint} ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const j = await r.json();
        for (const b of (j.data || [])) buckets.push(b);
        page = j.has_more ? j.next_page : null;
    } while (page && ++guard < 400);
    return buckets;
}

// Um "line" normaliza um result da Usage API para os campos que o pricing usa.
// Parsing DEFENSIVO: os nomes de campo variam por endpoint/versão; lemos os
// aliases conhecidos e guardamos o result cru em `raw` para diagnóstico.
function normalizeUsageResult(category, res) {
    const input = Number(res.input_tokens ?? 0);
    const cached = Number(res.input_cached_tokens ?? res.cached_tokens ?? 0);
    return {
        category,
        model: res.model || "(sem modelo)",
        api_key_id: res.api_key_id || null,
        input_tokens: input,
        cached_tokens: cached,
        // A Usage API já expõe o input NÃO-cacheado e o cache-write direto (input_tokens
        // = cached + uncached; cache_write é contador à parte). Fallback: input − cached.
        uncached_tokens: Number(res.input_uncached_tokens ?? Math.max(0, input - cached)),
        cache_write_tokens: Number(res.input_cache_write_tokens ?? 0),
        output_tokens: Number(res.output_tokens ?? 0),
        audio_seconds: Number(res.seconds ?? res.num_seconds ?? 0),
        characters: Number(res.characters ?? res.num_characters ?? 0),
        num_requests: Number(res.num_model_requests ?? res.num_requests ?? 0),
        raw: res,
    };
}

// Busca o consumo REAL da chave de benchmark na janela, por (endpoint, modelo).
// Filtra client-side pelo api_key_id da chave de benchmark (além do filtro na
// query) — cinto e suspensório, caso a API não honre o filtro em algum endpoint.
export async function fetchBenchmarkUsage({ startTime, endTime, bucketWidth = "1d" }) {
    const keyId = benchmarkApiKeyId();
    const projectId = benchmarkProjectId();
    const endpoints = ["completions", "audio_speeches", "audio_transcriptions"];
    const lines = [];
    const notes = [];
    for (const ep of endpoints) {
        try {
            const buckets = await fetchUsageBuckets(ep, {
                startTime, endTime, bucketWidth,
                groupBy: ["model", "api_key_id"],
                apiKeyIds: keyId ? [keyId] : null,
                projectIds: projectId ? [projectId] : null,
            });
            for (const b of buckets) {
                for (const res of (b.results || [])) {
                    const line = normalizeUsageResult(ep, res);
                    if (keyId && line.api_key_id && line.api_key_id !== keyId) continue;
                    lines.push(line);
                }
            }
        } catch (err) {
            notes.push(`${ep}: ${err.message}`);
            log.warn("COST_AUDIT", `Usage ${ep} falhou: ${err.message}`);
        }
    }
    if (!keyId && !projectId) notes.push("BENCHMARK_OPENAI_API_KEY_ID e BENCHMARK_OPENAI_PROJECT_ID ausentes — Usage NÃO isolada (inclui produção)");
    return { lines, notes };
}

// Costs API: US$ faturado no nível projeto/dia (cross-check). group_by line_item.
export async function fetchProjectCosts({ startTime, endTime }) {
    const adminKey = requireAdminKey();
    const projectId = benchmarkProjectId();
    const results = [];
    let page = null, guard = 0;
    do {
        const url = new URL(COSTS_URL);
        url.searchParams.set("start_time", String(startTime));
        url.searchParams.set("end_time", String(endTime));
        url.searchParams.set("bucket_width", "1d"); // Costs só suporta 1d
        url.searchParams.append("group_by[]", "line_item");
        // Projeto dedicado: filtra a Costs por ele → US$ faturado LIMPO do benchmark.
        // Sem project_id, a Costs é org-wide (só teto/sanidade).
        if (projectId) url.searchParams.append("project_ids[]", projectId);
        url.searchParams.set("limit", "180");
        if (page) url.searchParams.set("page", page);
        const r = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } });
        if (!r.ok) throw new Error(`Costs API ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const j = await r.json();
        for (const b of (j.data || [])) for (const res of (b.results || [])) results.push(res);
        page = j.has_more ? j.next_page : null;
    } while (page && ++guard < 400);
    let total = 0;
    const byLineItem = {};
    for (const res of results) {
        const v = Number(res.amount?.value ?? 0);
        total += v;
        const li = res.line_item || "(sem line_item)";
        byLineItem[li] = (byLineItem[li] || 0) + v;
    }
    return { total_usd: total, by_line_item: byLineItem, scoped_to_project: !!projectId };
}

// ---------------------------------------------------------------------------
// Puro (testável) — agregação e matemática de reconciliação
// ---------------------------------------------------------------------------

// event_type (work_cost_events) ↔ category (Usage API).
const EVENT_TO_CATEGORY = { responses: "completions", tts: "audio_speeches", stt: "audio_transcriptions", realtime: "realtime" };

// Agrega as linhas do lado CALCULADO (rows de aggregateCalculatedCost) por modelo.
export function summarizeCalculated(rows) {
    let calculatedUsd = 0;
    const byModel = {};
    for (const r of rows) {
        calculatedUsd += Number(r.cost_usd || 0);
        const m = r.model;
        const acc = byModel[m] || (byModel[m] = { input_tokens: 0, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, audio_chars: 0, cost_usd: 0, categories: {} });
        acc.input_tokens += Number(r.input_tokens || 0);
        acc.cached_tokens += Number(r.cached_tokens || 0);
        acc.output_tokens += Number(r.output_tokens || 0);
        acc.audio_seconds += Number(r.audio_seconds || 0);
        acc.audio_chars += Number(r.audio_chars || 0);
        acc.cost_usd += Number(r.cost_usd || 0);
        acc.categories[EVENT_TO_CATEGORY[r.event_type] || r.event_type] = true;
    }
    return { calculatedUsd, byModel };
}

// Agrega as linhas da Usage API (fetchBenchmarkUsage) por modelo.
export function summarizeUsage(lines) {
    const byModel = {};
    for (const l of lines) {
        const m = l.model;
        const acc = byModel[m] || (byModel[m] = { input_tokens: 0, cached_tokens: 0, output_tokens: 0, audio_seconds: 0, characters: 0, categories: {} });
        acc.input_tokens += l.input_tokens;
        acc.cached_tokens += l.cached_tokens;
        acc.output_tokens += l.output_tokens;
        acc.audio_seconds += l.audio_seconds;
        acc.characters += l.characters;
        acc.categories[l.category] = true;
    }
    return byModel;
}

// US$ de referência de UMA linha de uso real, aplicando pricing.yaml.
// Retorna { usd, priced } — priced=false se não há preço para o modelo/categoria.
export function referenceUsdForUsage(line, pricing) {
    const p = pricing || {};
    if (line.category === "completions") {
        const e = p.text?.[line.model];
        if (!e) return { usd: 0, priced: false };
        // Mesma fórmula do billing.js#computeResponsesCost: uncached ao preço cheio,
        // cached ao preço de cache-hit, cache-write ao preço de escrita, output cheio.
        const uncached = line.uncached_tokens ?? Math.max(0, line.input_tokens - line.cached_tokens);
        const usd = (
            uncached * e.input_per_mtok +
            line.cached_tokens * e.input_cached_per_mtok +
            (line.cache_write_tokens || 0) * Number(e.cache_write_per_mtok ?? 0) +
            line.output_tokens * e.output_per_mtok
        ) / 1e6;
        return { usd, priced: true };
    }
    if (line.category === "audio_transcriptions") {
        const e = p.stt?.[line.model];
        if (!e) return { usd: 0, priced: false };
        if (line.input_tokens > 0 || line.output_tokens > 0) {
            const usd = (line.input_tokens * (e.input_per_mtok ?? 0) + line.output_tokens * (e.output_per_mtok ?? 0)) / 1e6;
            return { usd, priced: true };
        }
        const usd = line.audio_seconds * (e.per_second_usd ?? 0);
        return { usd, priced: e.per_second_usd != null };
    }
    if (line.category === "audio_speeches") {
        const e = p.tts?.[line.model];
        if (!e) return { usd: 0, priced: false };
        const usd = (line.characters * e.text_per_mchar) / 1e6;
        return { usd, priced: true };
    }
    if (line.category === "realtime") {
        const e = p.realtime?.[line.model];
        if (!e) return { usd: 0, priced: false };
        // Usage não separa áudio/texto do realtime aqui; tratamos como input/output genéricos.
        const usd = (Math.max(0, line.input_tokens - line.cached_tokens) * (e.audio_input_per_mtok ?? 0)
            + line.cached_tokens * (e.cached_per_mtok ?? 0)
            + line.output_tokens * (e.audio_output_per_mtok ?? 0)) / 1e6;
        return { usd, priced: true };
    }
    return { usd: 0, priced: false };
}

// reference_usd total = Σ referência de cada linha de uso real.
export function referenceUsdTotal(lines, pricing) {
    let usd = 0;
    const unpriced = [];
    for (const l of lines) {
        const { usd: u, priced } = referenceUsdForUsage(l, pricing);
        usd += u;
        if (!priced) unpriced.push(`${l.category}:${l.model}`);
    }
    return { referenceUsd: usd, unpriced: [...new Set(unpriced)] };
}

// Deltas por modelo (real − calculado) sobre os campos de token.
export function computeTokenDeltas(calculatedByModel, usageByModel) {
    const models = new Set([...Object.keys(calculatedByModel), ...Object.keys(usageByModel)]);
    const out = {};
    for (const m of models) {
        const c = calculatedByModel[m] || {};
        const u = usageByModel[m] || {};
        out[m] = {
            input_tokens: (u.input_tokens || 0) - (c.input_tokens || 0),
            cached_tokens: (u.cached_tokens || 0) - (c.cached_tokens || 0),
            output_tokens: (u.output_tokens || 0) - (c.output_tokens || 0),
            audio_seconds: (u.audio_seconds || 0) - (c.audio_seconds || 0),
            // TTS: calculado guarda chars; Usage também expõe characters.
            characters: (u.characters || 0) - (c.audio_chars || 0),
            calculated: { input: c.input_tokens || 0, cached: c.cached_tokens || 0, output: c.output_tokens || 0, seconds: c.audio_seconds || 0, chars: c.audio_chars || 0 },
            actual: { input: u.input_tokens || 0, cached: u.cached_tokens || 0, output: u.output_tokens || 0, seconds: u.audio_seconds || 0, chars: u.characters || 0 },
        };
    }
    return out;
}

// Monta o objeto de reconciliação a partir dos dois lados já buscados. PURO:
// recebe rows calculados + usage lines + costs (+ pricing) e devolve o registro
// pronto para persistir. Facilita testar a matemática com fixtures.
export function buildReconciliation({ benchmarkRunId, windowStart, windowEnd, calculatedRows, usageLines, projectCosts, notes = [] }) {
    const pricing = loadPricing();
    const { calculatedUsd, byModel: calculatedByModel } = summarizeCalculated(calculatedRows);
    const usageByModel = summarizeUsage(usageLines);
    const { referenceUsd, unpriced } = referenceUsdTotal(usageLines, pricing);
    const deltaTokens = computeTokenDeltas(calculatedByModel, usageByModel);

    const haveUsage = usageLines.length > 0;
    const deltaUsd = haveUsage ? referenceUsd - calculatedUsd : null;
    const deltaPct = (haveUsage && calculatedUsd > 0) ? (deltaUsd / calculatedUsd) * 100 : null;

    const allNotes = [...notes];
    if (unpriced.length) allNotes.push(`sem preço local p/: ${unpriced.join(", ")}`);

    return {
        benchmarkRunId: benchmarkRunId ?? null,
        windowStart, windowEnd,
        calculatedUsd,
        calculatedTokensJson: calculatedByModel,
        actualUsageTokensJson: haveUsage ? usageByModel : null,
        referenceUsd: haveUsage ? referenceUsd : null,
        costsApiProjectUsd: projectCosts ? projectCosts.total_usd : null,
        deltaTokensJson: haveUsage ? deltaTokens : null,
        deltaUsd,
        deltaPct,
        status: "pending",
        note: allNotes.length ? allNotes.join(" | ") : null,
    };
}

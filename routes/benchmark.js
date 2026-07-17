import express from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import { PROJECT_ROOT, requireAdmin } from "../lib/middleware.js";
import { loadCaseSeeds, validateFrozenCases } from "../lib/bench/cases.js";
import { buildReleaseComparison } from "../lib/bench/comparison.js";
import { runBenchmark } from "../lib/bench/runner.js";
import { generateCanonicalSetup } from "../lib/bench/setupGenerator.js";
import * as store from "../lib/bench/store.js";
import * as versions from "../lib/bench/versionStore.js";
import { buildBundle, importBundle } from "../lib/bench/portable.js";
import { summarizeBundle, validateBundle } from "../lib/bench/portableFormat.js";
import { sha256 } from "../lib/bench/util.js";
import log from "../lib/logger.js";

const router = express.Router();
const activeRuns = new Map();
const activeGenerations = new Map();
const defaultConfigPath = path.join(PROJECT_ROOT, "config", "benchmark.yaml");
let bootstrapPromise = null;

function defaultConfig() { return yaml.load(fs.readFileSync(defaultConfigPath, "utf8")); }
async function ensureVersions() {
    if (!bootstrapPromise) {
        const config = defaultConfig();
        const juryConfig = { judges: config.judges, operational_policy: { minimum_available: 1 } };
        const draftConfig = {
            case_ids: [], rag: config.rag, consensus: config.consensus, prompts: config.prompts,
            setup_council_version: "J0.1", max_generation_cost_usd: config.limits.max_cost_usd, max_generation_calls: 250,
        };
        bootstrapPromise = versions.ensureInitialBenchmark({ draftConfig, juryConfig });
    }
    return bootstrapPromise;
}
function runKey() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function runArtifactDir(config, key) { return path.resolve(config.storage.runs_dir, key); }
function publicConfig(config) {
    return { candidates: config.candidates, judges: config.judges, case_ids: config.case_ids, max_cost_usd: config.limits.max_cost_usd, random_seed: config.random_seed, latency_repetitions: config.limits.latency_repetitions || 1 };
}

function providerStatus(config) {
    return [
        { key: "openai", name: "OpenAI", configured: Boolean(process.env.OPENAI_API_KEY), cost: "estimado por tokens" },
        { key: "anthropic", name: "Anthropic", configured: Boolean(process.env.ANTHROPIC_API_KEY), cost: Object.keys(config.providers?.anthropic?.pricing || {}).length ? "estimado por tokens" : "tabela nao configurada" },
        { key: "gemini", name: "Google Gemini", configured: Boolean(process.env.GEMINI_API_KEY), cost: Object.keys(config.providers?.gemini?.pricing || {}).length ? "estimado por tokens" : "tabela nao configurada" },
        { key: "xai", name: "xAI", configured: Boolean(process.env.XAI_API_KEY), cost: "exato por resposta" },
        { key: "meta", name: "Meta", configured: Boolean(process.env.META_API_KEY), available: false, cost: process.env.META_API_KEY ? "chave configurada; adaptador pendente" : "sem chave; adaptador pendente" },
    ];
}

function resolveConfig(body = {}) {
    const config = defaultConfig();
    if (Array.isArray(body.candidates) && body.candidates.length) config.candidates = body.candidates.map(String);
    if (Array.isArray(body.judges) && body.judges.length) config.judges = body.judges.map(String);
    if (Array.isArray(body.case_ids)) config.case_ids = body.case_ids.map(String);
    if (body.max_cost_usd != null) config.limits.max_cost_usd = Number(body.max_cost_usd);
    if (body.random_seed != null) config.random_seed = String(body.random_seed);
    if (body.latency_repetitions != null) config.limits.latency_repetitions = Number(body.latency_repetitions);
    if (!Number.isFinite(config.limits.max_cost_usd) || config.limits.max_cost_usd <= 0 || config.limits.max_cost_usd > 1000) throw new Error("max_cost_usd deve estar entre 0 e 1000");
    if (!Number.isInteger(config.limits.latency_repetitions) || config.limits.latency_repetitions < 1 || config.limits.latency_repetitions > 5) throw new Error("repeticoes de latencia deve estar entre 1 e 5");
    for (const spec of [...config.candidates, ...config.judges]) {
        if (!/^(openai|anthropic|gemini|xai):[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(spec)) throw new Error(`modelo ou fornecedor invalido: ${spec}`);
    }
    return config;
}

function launch(config, key, casesOverride = null, { resume = false } = {}) {
    const controller = new AbortController();
    activeRuns.set(key, controller);
    void (async () => {
        try {
            await store.markRunning(key, runArtifactDir(config, key));
            const result = await runBenchmark({ ...config, run_key: key }, { signal: controller.signal, casesOverride, resume, onProgress: (done) => store.updateProgress(key, done) });
            const raw = JSON.parse(fs.readFileSync(path.join(result.runDir, "raw.json"), "utf8"));
            await store.completeRun(key, result, raw);
        } catch (err) {
            const status = err?.code === "BENCH_CANCELLED" ? "cancelled" : "failed";
            log.error("BENCHMARK", `run=${key} ${status}: ${err.message}`);
            await store.failRun(key, err, status).catch((dbErr) => log.error("BENCHMARK", `falha ao persistir erro run=${key}: ${dbErr.message}`));
        } finally { activeRuns.delete(key); }
    })();
}

function launchGeneration({ key, draft, cases, council, config, artifactDir }) {
    const controller = new AbortController();
    activeGenerations.set(key, controller);
    void (async () => {
        try {
            await versions.markGenerationRunning(key);
            const result = await generateCanonicalSetup({
                key, cases, council, config, artifactDir, signal: controller.signal,
                onProgress: (progress) => versions.updateGenerationProgress(key, progress),
            });
            await versions.completeGeneration(key, result, result.calls);
        } catch (err) {
            const status = err?.code === "BENCH_CANCELLED" ? "cancelled" : "failed";
            log.error("BENCHMARK_SETUP", `generation=${key} ${status}: ${err.message}`);
            await versions.failGeneration(key, err, status, err.generationCalls || []).catch((dbErr) => log.error("BENCHMARK_SETUP", `falha ao persistir erro generation=${key}: ${dbErr.message}`));
        } finally { activeGenerations.delete(key); }
    })();
}

router.get("/api/benchmark/config", requireAdmin, (_req, res) => {
    try { res.json({ config: publicConfig(defaultConfig()) }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/providers", requireAdmin, (_req, res) => {
    const config = defaultConfig();
    res.json({
        providers: providerStatus(config),
        models: Array.isArray(config.model_catalog) ? config.model_catalog : [],
        pending_models: Array.isArray(config.model_catalog_pending) ? config.model_catalog_pending : [],
    });
});

router.get("/api/benchmark/cases", requireAdmin, (_req, res) => {
    try {
        const config = defaultConfig();
        const cases = loadCaseSeeds(path.resolve(PROJECT_ROOT, config.cases_dir)).map((item) => ({
            id: item.id, area: item.area, large_area: item.large_area, course_level: item.course_level,
            interviewer_persona: item.interviewer_persona, student_persona: item.student_persona,
            states: item.student_states.length, source_hash: item.source_hash,
        }));
        res.json({ cases });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/cases/:caseId", requireAdmin, (req, res) => {
    try {
        const config = defaultConfig();
        const testCase = loadCaseSeeds(path.resolve(PROJECT_ROOT, config.cases_dir), [req.params.caseId])[0];
        res.json({ case: testCase });
    } catch (err) {
        const missing = String(err.message || "").includes("casos nao encontrados");
        res.status(missing ? 404 : 500).json({ error: missing ? "case not found" : err.message });
    }
});

router.get("/api/benchmark/setup-drafts", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ drafts: await versions.listSetupDrafts() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/benchmark/setup-drafts", requireAdmin, async (req, res) => {
    try {
        await ensureVersions();
        const config = defaultConfig();
        const draft = await versions.createSetupDraft({
            name: req.body?.name, description: req.body?.description,
            config: req.body?.config || { case_ids: [], rag: config.rag, consensus: config.consensus, prompts: config.prompts, setup_council_version: "J0.1", max_generation_cost_usd: config.limits.max_cost_usd, max_generation_calls: 250 },
            userId: req.session.user.id,
        });
        res.status(201).json({ draft });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch("/api/benchmark/setup-drafts/:id", requireAdmin, async (req, res) => {
    try { res.json({ draft: await versions.updateSetupDraft(req.params.id, req.body || {}) }); }
    catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

router.post("/api/benchmark/setup-drafts/:id/generate", requireAdmin, async (req, res) => {
    try {
        const draft = await versions.getSetupDraft(req.params.id);
        if (!draft) return res.status(404).json({ error: "setup draft not found" });
        const active = await versions.findActiveGeneration(draft.id);
        if (active) return res.status(409).json({ error: `ja existe uma geracao ativa para este setup: ${active.generation_key}` });
        const config = defaultConfig();
        const caseIds = draft.config_json?.case_ids || [];
        const cases = loadCaseSeeds(path.resolve(PROJECT_ROOT, config.cases_dir), caseIds);
        const councilVersionKey = draft.config_json?.setup_council_version;
        const councilVersion = await versions.getJuryVersion(councilVersionKey);
        if (!councilVersion) return res.status(400).json({ error: "versao do conselho do setup obrigatoria" });
        const council = councilVersion.config_json?.judges || [];
        if (!council.length) return res.status(400).json({ error: "conselho do setup sem modelos" });
        const key = `setup-${runKey()}`;
        const maxGenerationCost = Number(req.body?.max_cost_usd || draft.config_json?.max_generation_cost_usd || config.limits.max_cost_usd);
        if (!Number.isFinite(maxGenerationCost) || maxGenerationCost <= 0 || maxGenerationCost > 1000) return res.status(400).json({ error: "limite de custo da geracao deve estar entre 0 e 1000" });
        const maxGenerationCalls = Number(draft.config_json?.max_generation_calls || 250);
        if (!Number.isInteger(maxGenerationCalls) || maxGenerationCalls < 1 || maxGenerationCalls > 5000) return res.status(400).json({ error: "limite de chamadas da geracao deve estar entre 1 e 5000" });
        const generationConfig = {
            ...config,
            setup_config: draft.config_json,
            rag: draft.config_json?.rag || config.rag,
            prompts: draft.config_json?.prompts || config.prompts,
            limits: { ...config.limits, max_cost_usd: maxGenerationCost, max_calls: maxGenerationCalls },
        };
        const progressTotal = cases.reduce((sum, item) => sum + item.student_states.length, 0) * (1 + 2 * council.length);
        const artifactDir = path.resolve(PROJECT_ROOT, "bench", "setup-generations", key);
        const generation = await versions.createGeneration({ key, setupDraftId: draft.id, config: generationConfig, artifactDir, userId: req.session.user.id, progressTotal });
        launchGeneration({ key, draft, cases, council, config: generationConfig, artifactDir });
        res.status(202).json({ generation });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get("/api/benchmark/setup-generations", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ generations: await versions.listGenerations() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/setup-generations/:key", requireAdmin, async (req, res) => {
    try {
        const generation = await versions.getGenerationForDisplay(req.params.key);
        if (!generation) return res.status(404).json({ error: "geracao nao encontrada" });
        res.json({ generation });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/setup-generations/:key/calls/:id", requireAdmin, async (req, res) => {
    try {
        const call = await versions.getGenerationCall(req.params.key, req.params.id);
        if (!call) return res.status(404).json({ error: "chamada nao encontrada" });
        res.json({ call });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/benchmark/setup-generations/:key/cancel", requireAdmin, (req, res) => {
    const controller = activeGenerations.get(req.params.key);
    if (!controller) return res.status(409).json({ error: "geracao nao esta ativa" });
    controller.abort();
    res.json({ ok: true });
});

router.get("/api/benchmark/setup-versions", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ versions: await versions.listSetupVersions() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Detalhe de uma versão S publicada, COM o manifesto (as entrevistas
// congeladas) — a listagem acima não o carrega. É o que permite inspecionar
// o conteúdo de uma versão sem depender da geração de origem existir.
router.get("/api/benchmark/setup-versions/:versionKey", requireAdmin, async (req, res) => {
    try {
        await ensureVersions();
        const version = await versions.getSetupVersion(req.params.versionKey);
        if (!version) return res.status(404).json({ error: "versao nao encontrada" });
        res.json({ version });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/benchmark/setup-versions", requireAdmin, async (req, res) => {
    try {
        const generation = await versions.getGeneration(req.body?.generation_key);
        if (!generation || generation.status !== "completed") return res.status(400).json({ error: "geracao concluida obrigatoria" });
        const setupVersion = await versions.publishSetupVersion({
            version: req.body?.version, generationKey: generation.generation_key,
            name: req.body?.name || generation.generation_key, description: req.body?.description,
            classification: req.body?.classification || "experimental", manifest: generation.result_json,
            userId: req.session.user.id,
        });
        res.status(201).json({ version: setupVersion });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get("/api/benchmark/jury-versions", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ versions: await versions.listJuryVersions() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/benchmark/jury-versions", requireAdmin, async (req, res) => {
    try {
        const judges = Array.isArray(req.body?.judges) ? req.body.judges.map(String) : [];
        if (!judges.length) throw new Error("ao menos um juiz obrigatorio");
        const juryVersion = await versions.publishJuryVersion({
            version: req.body?.version, name: req.body?.name || "Conselho de juizes",
            description: req.body?.description, config: { judges, operational_policy: req.body?.operational_policy || { minimum_available: judges.length } },
            userId: req.session.user.id,
        });
        res.status(201).json({ version: juryVersion });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get("/api/benchmark/releases", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ releases: await versions.listReleases() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/benchmark/releases", requireAdmin, async (req, res) => {
    try {
        const release = await versions.createRelease({ setupVersionKey: req.body?.setup_version_key, juryVersionKey: req.body?.jury_version_key, name: req.body?.name, userId: req.session.user.id });
        res.status(201).json({ release });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get("/api/benchmark/runs", requireAdmin, async (req, res) => {
    try {
        const runs = (await store.listRuns(req.query.limit)).map((run) => ({
            ...run, active: activeRuns.has(run.run_key),
            resumable: run.status !== "completed" && !activeRuns.has(run.run_key),
        }));
        res.json({ runs });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/comparisons/:releaseKey", requireAdmin, async (req, res) => {
    try {
        const release = await versions.getRelease(req.params.releaseKey);
        if (!release) return res.status(404).json({ error: "versao S-J nao encontrada" });
        const data = await store.getCompletedReleaseData(release.release_key);
        res.json({ release, comparison: buildReleaseComparison(data) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/runs/:runKey", requireAdmin, async (req, res) => {
    try {
        const details = await store.getRunDetails(req.params.runKey);
        if (!details) return res.status(404).json({ error: "run not found" });
        details.run.active = activeRuns.has(details.run.run_key);
        details.run.resumable = details.run.status !== "completed" && !details.run.active;
        res.json(details);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/runs/:runKey/artifacts", requireAdmin, async (req, res) => {
    try {
        const run = await store.getRun(req.params.runKey);
        if (!run) return res.status(404).json({ error: "run not found" });
        if (!run.artifact_dir || !fs.existsSync(run.artifact_dir)) return res.json({ artifacts: [] });
        const artifacts = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else artifacts.push({ path: path.relative(run.artifact_dir, full).replaceAll("\\", "/"), bytes: fs.statSync(full).size });
            }
        };
        walk(run.artifact_dir);
        res.json({ artifacts });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/runs/:runKey/artifact", requireAdmin, async (req, res) => {
    try {
        const run = await store.getRun(req.params.runKey);
        if (!run?.artifact_dir) return res.status(404).json({ error: "artifact not found" });
        const root = path.resolve(run.artifact_dir);
        const requested = path.resolve(root, String(req.query.path || ""));
        if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) return res.status(400).json({ error: "invalid path" });
        if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return res.status(404).json({ error: "artifact not found" });
        res.type(path.extname(requested) === ".json" || path.extname(requested) === ".jsonl" ? "application/json" : "text/plain").send(fs.readFileSync(requested, "utf8"));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/benchmark/runs", requireAdmin, async (req, res) => {
    try {
        await ensureVersions();
        const release = await versions.getRelease(req.body?.release_key);
        if (!release) return res.status(400).json({ error: "versao S-J obrigatoria" });
        const frozenCases = validateFrozenCases(release.setup_manifest?.cases);
        const config = resolveConfig({ ...req.body, judges: release.jury_config?.judges, case_ids: frozenCases.map((item) => item.id) });
        config.setup_version = release.setup_version_key;
        config.context_version = "embedded";
        config.jury_version = release.jury_version_key;
        config.rag = release.setup_manifest?.config?.rag || release.setup_manifest?.setup_config?.rag || config.rag;
        config.consensus = release.setup_manifest?.config?.consensus || release.setup_manifest?.setup_config?.consensus || config.consensus;
        config.prompts = release.setup_manifest?.config?.prompts || release.setup_manifest?.setup_config?.prompts || {};
        const fingerprint = sha256([...config.candidates].sort());
        const duplicate = await versions.findDuplicateRun(release.release_key, fingerprint);
        if (duplicate && req.body?.allow_repeat !== true) return res.status(409).json({ error: "duplicate_evaluation", existing_run: duplicate });
        const cases = frozenCases;
        const total = cases.reduce((sum, item) => sum + item.turns.length, 0) * config.candidates.length * (config.limits.latency_repetitions + config.judges.length);
        const key = runKey();
        const runConfig = { ...config, run_key: key };
        await store.createRun({ runKey: key, config: runConfig, userId: req.session.user.id, progressTotal: total, releaseKey: release.release_key, candidateFingerprint: fingerprint, artifactDir: runArtifactDir(runConfig, key) });
        launch(config, key, cases);
        res.status(202).json({ run_key: key, status: "queued", progress_total: total });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/benchmark/runs/:runKey/resume", requireAdmin, async (req, res) => {
    try {
        const key = req.params.runKey;
        if (activeRuns.has(key)) return res.status(409).json({ error: "execucao ja esta ativa" });
        const run = await store.getRun(key);
        if (!run) return res.status(404).json({ error: "execucao nao encontrada" });
        if (run.status === "completed") return res.status(409).json({ error: "execucao ja esta concluida" });

        const config = { ...run.config_json, run_key: key };
        const runDir = run.artifact_dir || runArtifactDir(config, key);
        const rawFile = path.join(runDir, "raw.json");
        if (fs.existsSync(rawFile)) {
            const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
            if (raw?.run?.run_key !== key) throw new Error("artefato raw.json pertence a outra execucao");
            const metrics = JSON.parse(fs.readFileSync(path.join(runDir, "metrics.json"), "utf8"));
            await store.markRunning(key, runDir);
            await store.completeRun(key, { run: raw.run, metrics, runDir }, raw);
            return res.json({ run_key: key, status: "completed", recovery: "artifacts_reimported" });
        }

        const checkpointFile = path.join(runDir, "checkpoint.json");
        if (!fs.existsSync(checkpointFile)) return res.status(409).json({ error: "execucao sem artefato final ou checkpoint retomavel" });
        const release = await versions.getRelease(run.release_key);
        if (!release) throw new Error("versao S-J da execucao nao foi encontrada");
        const cases = validateFrozenCases(release.setup_manifest?.cases);
        launch(config, key, cases, { resume: true });
        res.status(202).json({ run_key: key, status: "queued", recovery: "checkpoint" });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/benchmark/runs/:runKey/cancel", requireAdmin, (req, res) => {
    const controller = activeRuns.get(req.params.runKey);
    if (!controller) return res.status(409).json({ error: "run is not active" });
    controller.abort();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Portabilidade de resultados entre ambientes.
// Export: baixa um "super arquivo" JSON auto-contido (versoes S/J + releases +
// runs completos). Import: grava esse arquivo no banco local de forma idempotente.
// ---------------------------------------------------------------------------

router.get("/api/benchmark/export", requireAdmin, async (req, res) => {
    try {
        const scope = req.query.run ? { runKey: String(req.query.run) }
            : req.query.release ? { releaseKey: String(req.query.release) }
            : { all: true };
        const bundle = await buildBundle(scope);
        const tag = scope.runKey ? `run-${scope.runKey}` : scope.releaseKey ? `release-${scope.releaseKey}` : "all";
        const safeTag = tag.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
        res.setHeader("Content-Disposition", `attachment; filename="oratia-bench-${safeTag}.json"`);
        res.type("application/json").send(JSON.stringify(bundle, null, 2));
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/benchmark/import", requireAdmin, express.json({ limit: "200mb" }), async (req, res) => {
    try {
        const bundle = req.body;
        validateBundle(bundle);
        const summary = summarizeBundle(bundle);
        const imported = await importBundle(bundle);
        log.info("BENCH", `import bundle: ${JSON.stringify(imported)} (conteudo: ${JSON.stringify(summary)})`);
        res.json({ ok: true, imported, bundle: summary });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

export default router;

import express from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import { PROJECT_ROOT, requireAdmin } from "../lib/middleware.js";
import { loadCases } from "../lib/bench/cases.js";
import { runBenchmark } from "../lib/bench/runner.js";
import { retrieveEvidence } from "../lib/bench/rag.js";
import * as store from "../lib/bench/store.js";
import * as versions from "../lib/bench/versionStore.js";
import { sha256 } from "../lib/bench/util.js";
import log from "../lib/logger.js";

const router = express.Router();
const activeRuns = new Map();
const defaultConfigPath = path.join(PROJECT_ROOT, "config", "benchmark.yaml");
let bootstrapPromise = null;

function defaultConfig() { return yaml.load(fs.readFileSync(defaultConfigPath, "utf8")); }
async function ensureVersions() {
    if (!bootstrapPromise) {
        const config = defaultConfig();
        const cases = loadCases(path.resolve(PROJECT_ROOT, config.cases_dir));
        const setupManifest = { classification: "fixture", cases, config: { rag: config.rag, consensus: config.consensus, prompts: config.prompts, generation_council: [], validation_council: config.judges } };
        const juryConfig = { judges: config.judges, operational_policy: { minimum_available: 1 } };
        bootstrapPromise = versions.bootstrapFixtureVersions({ setupManifest, juryConfig });
    }
    return bootstrapPromise;
}
function runKey() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function publicConfig(config) {
    return { candidates: config.candidates, judges: config.judges, case_ids: config.case_ids, max_cost_usd: config.limits.max_cost_usd, random_seed: config.random_seed };
}

function resolveConfig(body = {}) {
    const config = defaultConfig();
    if (Array.isArray(body.candidates) && body.candidates.length) config.candidates = body.candidates.map(String);
    if (Array.isArray(body.judges) && body.judges.length) config.judges = body.judges.map(String);
    if (Array.isArray(body.case_ids)) config.case_ids = body.case_ids.map(String);
    if (body.max_cost_usd != null) config.limits.max_cost_usd = Number(body.max_cost_usd);
    if (body.random_seed != null) config.random_seed = String(body.random_seed);
    if (!Number.isFinite(config.limits.max_cost_usd) || config.limits.max_cost_usd <= 0 || config.limits.max_cost_usd > 1000) throw new Error("max_cost_usd deve estar entre 0 e 1000");
    for (const spec of [...config.candidates, ...config.judges]) {
        if (!/^(openai|anthropic|gemini|xai):[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(spec)) throw new Error(`modelo ou fornecedor invalido: ${spec}`);
    }
    return config;
}

function launch(config, key, casesOverride = null) {
    const controller = new AbortController();
    activeRuns.set(key, controller);
    void (async () => {
        try {
            await store.markRunning(key);
            const result = await runBenchmark({ ...config, run_key: key }, { signal: controller.signal, casesOverride, onProgress: (done) => store.updateProgress(key, done) });
            const raw = JSON.parse(fs.readFileSync(path.join(result.runDir, "raw.json"), "utf8"));
            await store.completeRun(key, result, raw);
        } catch (err) {
            const status = err?.code === "BENCH_CANCELLED" ? "cancelled" : "failed";
            log.error("BENCHMARK", `run=${key} ${status}: ${err.message}`);
            await store.failRun(key, err, status).catch((dbErr) => log.error("BENCHMARK", `falha ao persistir erro run=${key}: ${dbErr.message}`));
        } finally { activeRuns.delete(key); }
    })();
}

router.get("/api/benchmark/config", requireAdmin, (_req, res) => {
    try { res.json({ config: publicConfig(defaultConfig()) }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/providers", requireAdmin, (_req, res) => {
    const config = defaultConfig();
    res.json({ providers: [
        { key: "openai", name: "OpenAI", configured: Boolean(process.env.OPENAI_API_KEY), cost: "estimado por tokens" },
        { key: "anthropic", name: "Anthropic", configured: Boolean(process.env.ANTHROPIC_API_KEY), cost: Object.keys(config.providers?.anthropic?.pricing || {}).length ? "estimado por tokens" : "tabela nao configurada" },
        { key: "gemini", name: "Google Gemini", configured: Boolean(process.env.GEMINI_API_KEY), cost: Object.keys(config.providers?.gemini?.pricing || {}).length ? "estimado por tokens" : "tabela nao configurada" },
        { key: "xai", name: "xAI", configured: Boolean(process.env.XAI_API_KEY), cost: "exato por resposta" },
    ] });
});

router.get("/api/benchmark/cases", requireAdmin, (_req, res) => {
    try {
        const config = defaultConfig();
        const cases = loadCases(path.resolve(PROJECT_ROOT, config.cases_dir)).map((item) => ({ id: item.id, area: item.area, large_area: item.large_area, course_level: item.course_level, persona: item.persona, turns: item.turns.length, document_hash: item.document_hash }));
        res.json({ cases });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/cases/:caseId", requireAdmin, (req, res) => {
    try {
        const config = defaultConfig();
        const testCase = loadCases(path.resolve(PROJECT_ROOT, config.cases_dir), [req.params.caseId])[0];
        const rag = testCase.turns.map((turn) => ({ turn_id: turn.id, ...retrieveEvidence(testCase, turn, config.rag || {}) }));
        res.json({ case: testCase, rag });
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
            config: req.body?.config || { case_ids: [], rag: config.rag, consensus: config.consensus, prompts: config.prompts, generation_council: [], validation_council: config.judges },
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
        const config = defaultConfig();
        const caseIds = draft.config_json?.case_ids || [];
        const cases = loadCases(path.resolve(PROJECT_ROOT, config.cases_dir), caseIds);
        const key = `setup-${runKey()}`;
        const result = {
            cases,
            setup_config: draft.config_json,
            provenance: {
                mode: "fixture_snapshot",
                generated_at: new Date().toISOString(),
                note: "Snapshot dos casos simplificados; nenhuma LLM foi chamada nesta geracao.",
            },
        };
        const generation = await versions.createGeneration({ key, setupDraftId: draft.id, config: draft.config_json, result, userId: req.session.user.id });
        res.status(201).json({ generation });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get("/api/benchmark/setup-generations", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ generations: await versions.listGenerations() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/setup-versions", requireAdmin, async (_req, res) => {
    try { await ensureVersions(); res.json({ versions: await versions.listSetupVersions() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
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
    try { res.json({ runs: await store.listRuns(req.query.limit) }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/api/benchmark/runs/:runKey", requireAdmin, async (req, res) => {
    try {
        const details = await store.getRunDetails(req.params.runKey);
        if (!details) return res.status(404).json({ error: "run not found" });
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
        const frozenCases = release.setup_manifest?.cases;
        if (!Array.isArray(frozenCases) || !frozenCases.length) return res.status(400).json({ error: "setup publicado sem casos congelados" });
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
        const total = cases.reduce((sum, item) => sum + item.turns.length, 0) * config.candidates.length * (1 + config.judges.length);
        const key = runKey();
        await store.createRun({ runKey: key, config: { ...config, run_key: key }, userId: req.session.user.id, progressTotal: total, releaseKey: release.release_key, candidateFingerprint: fingerprint });
        launch(config, key, cases);
        res.status(202).json({ run_key: key, status: "queued", progress_total: total });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/benchmark/runs/:runKey/cancel", requireAdmin, (req, res) => {
    const controller = activeRuns.get(req.params.runKey);
    if (!controller) return res.status(409).json({ error: "run is not active" });
    controller.abort();
    res.json({ ok: true });
});

export default router;

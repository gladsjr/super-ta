import { pool } from "../../auth.js";
import { sha256 } from "./util.js";

function versionParts(value, size) {
    const parts = String(value || "").split(".").map(Number);
    if (parts.length !== size || parts.some((part) => !Number.isInteger(part) || part < 0)) throw new Error(`versao deve ter ${size} componentes numericos`);
    return parts;
}

export async function listSetupDrafts() {
    return (await pool.query("SELECT * FROM benchmark_setup_drafts WHERE status='draft' ORDER BY updated_at DESC")).rows;
}

export async function createSetupDraft({ name, description = "", config, userId }) {
    if (!String(name || "").trim()) throw new Error("nome do setup obrigatorio");
    return (await pool.query(
        `INSERT INTO benchmark_setup_drafts (name,description,config_json,created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [String(name).trim(), String(description), config || {}, userId || null]
    )).rows[0];
}

export async function updateSetupDraft(id, { name, description, config }) {
    const result = await pool.query(
        `UPDATE benchmark_setup_drafts SET name=COALESCE($2,name),description=COALESCE($3,description),config_json=COALESCE($4,config_json),updated_at=now()
         WHERE id=$1 AND status='draft' RETURNING *`,
        [id, name ?? null, description ?? null, config ?? null]
    );
    if (!result.rowCount) throw Object.assign(new Error("setup draft not found"), { status: 404 });
    return result.rows[0];
}

export async function getSetupDraft(id) {
    return (await pool.query("SELECT * FROM benchmark_setup_drafts WHERE id=$1", [id])).rows[0] || null;
}

export async function createGeneration({ key, setupDraftId, config, artifactDir = null, userId, progressTotal = 0, mode = "llm_council" }) {
    return (await pool.query(
        `INSERT INTO benchmark_setup_generations (generation_key,setup_draft_id,status,mode,config_json,artifact_dir,created_by,progress_total)
         VALUES ($1,$2,'queued',$3,$4,$5,$6,$7) RETURNING *`,
        [key, setupDraftId, mode, config || {}, artifactDir, userId || null, progressTotal]
    )).rows[0];
}

export async function markGenerationRunning(key) {
    await pool.query("UPDATE benchmark_setup_generations SET status='running' WHERE generation_key=$1", [key]);
}

export async function updateGenerationProgress(key, progress) {
    await pool.query(
        `UPDATE benchmark_setup_generations SET progress_done=$2,known_cost_usd=$3,progress_json=$4 WHERE generation_key=$1`,
        [key, Number(progress.calls || 0), progress.cost_usd ?? null, progress || {}]
    );
}

async function insertGenerationCalls(client, key, calls) {
    for (const call of calls || []) {
        await client.query(
            `INSERT INTO benchmark_generation_calls
             (generation_key,call_id,provider,model,effort,role,case_id,turn_id,request_json,response_json,request_hash,response_hash,usage_json,latency_ms,cost_estimated_usd,cost_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (generation_key,call_id) DO NOTHING`,
            [key, call.call_id, call.provider, call.model, call.effort, call.role, call.case_id, call.turn_id,
                call.request || {}, call.response || {}, call.request_hash, call.response_hash, call.usage || {},
                call.latency_ms, call.cost_estimated_usd, call.cost_source || "unavailable"]
        );
    }
}

export async function completeGeneration(key, result, calls) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE benchmark_setup_generations SET status='completed',result_json=$2,known_cost_usd=$3,
             progress_done=progress_total,finished_at=now() WHERE generation_key=$1`,
            [key, result, result.provenance?.known_cost_usd ?? null]
        );
        await insertGenerationCalls(client, key, calls);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally { client.release(); }
}

export async function failGeneration(key, err, status = "failed", calls = []) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE benchmark_setup_generations SET status=$2,error_text=$3,finished_at=now(),
             progress_done=$4,known_cost_usd=$5,progress_json=$6 WHERE generation_key=$1`,
            [key, status, String(err?.stack || err?.message || err).slice(0, 12000), calls.length,
                err?.knownCostUsd ?? null, err?.progress || { calls: calls.length }]
        );
        await insertGenerationCalls(client, key, calls);
        await client.query("COMMIT");
    } catch (persistErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw persistErr;
    } finally { client.release(); }
}

export async function getGenerationCalls(key) {
    return (await pool.query("SELECT * FROM benchmark_generation_calls WHERE generation_key=$1 ORDER BY id", [key])).rows;
}

export async function listGenerations() {
    return (await pool.query(
        `SELECT g.generation_key,g.setup_draft_id,g.status,g.mode,g.config_json,
                CASE WHEN g.result_json IS NULL THEN NULL ELSE g.result_json - 'calls' - 'cases' END AS result_json,
                g.artifact_dir,g.error_text,g.created_by,g.created_at,g.finished_at,g.progress_done,g.progress_total,g.known_cost_usd,g.progress_json,
                d.name AS setup_name
         FROM benchmark_setup_generations g JOIN benchmark_setup_drafts d ON d.id=g.setup_draft_id ORDER BY g.created_at DESC`
    )).rows;
}

export async function getGeneration(key) {
    return (await pool.query("SELECT * FROM benchmark_setup_generations WHERE generation_key=$1", [key])).rows[0] || null;
}

export async function findActiveGeneration(setupDraftId) {
    return (await pool.query(
        "SELECT generation_key,status,created_at FROM benchmark_setup_generations WHERE setup_draft_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
        [setupDraftId]
    )).rows[0] || null;
}

export async function getGenerationForDisplay(key) {
    const [generation, calls] = await Promise.all([
        pool.query(
            `SELECT generation_key,setup_draft_id,status,mode,config_json,
                    CASE WHEN result_json IS NULL THEN NULL ELSE result_json - 'calls' END AS result_json,
                    artifact_dir,error_text,created_by,created_at,finished_at,progress_done,progress_total,known_cost_usd,progress_json
             FROM benchmark_setup_generations WHERE generation_key=$1`, [key]
        ),
        pool.query(
            `SELECT id,call_id,provider,model,effort,role,case_id,turn_id,request_hash,response_hash,usage_json,latency_ms,cost_estimated_usd,cost_source,created_at
             FROM benchmark_generation_calls WHERE generation_key=$1 ORDER BY id`, [key]
        ),
    ]);
    return generation.rows[0] ? { ...generation.rows[0], calls: calls.rows } : null;
}

export async function getGenerationCall(key, id) {
    return (await pool.query("SELECT * FROM benchmark_generation_calls WHERE generation_key=$1 AND id=$2", [key, id])).rows[0] || null;
}

export async function ensureInitialBenchmark({ draftConfig, juryConfig }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `INSERT INTO benchmark_jury_versions
             (version_key,version_major,version_minor,name,description,config_json,manifest_hash)
             VALUES ('J0.1',0,1,'Conselho inicial','Conselho inicial disponivel para setup e avaliacao',$1,$2)
             ON CONFLICT (version_key) DO NOTHING`,
            [juryConfig, sha256(juryConfig)]
        );
        const draftCount = await client.query("SELECT count(*)::int AS count FROM benchmark_setup_drafts WHERE status='draft'");
        if (!draftCount.rows[0].count) {
            await client.query(
                `INSERT INTO benchmark_setup_drafts (name,description,config_json)
                 VALUES ('Setup piloto estruturado','Casos realistas para gerar as primeiras entrevistas canonicas',$1)`,
                [draftConfig]
            );
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally { client.release(); }
}

export async function publishSetupVersion({ version, generationKey, name, description = "", classification = "validated", manifest, userId }) {
    const [major, minor, build] = versionParts(version, 3);
    const versionKey = `S${major}.${minor}.${build}`;
    const hash = sha256(manifest);
    return (await pool.query(
        `INSERT INTO benchmark_setup_versions
         (version_key,version_major,version_minor,version_build,name,description,classification,source_generation_key,manifest_json,manifest_hash,published_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [versionKey, major, minor, build, name, description, classification, generationKey || null, manifest, hash, userId || null]
    )).rows[0];
}

export async function listSetupVersions() {
    return (await pool.query("SELECT * FROM benchmark_setup_versions ORDER BY version_major DESC,version_minor DESC,version_build DESC")).rows;
}

export async function publishJuryVersion({ version, name, description = "", config, userId }) {
    const [major, minor] = versionParts(version, 2);
    const versionKey = `J${major}.${minor}`;
    return (await pool.query(
        `INSERT INTO benchmark_jury_versions
         (version_key,version_major,version_minor,name,description,config_json,manifest_hash,published_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [versionKey, major, minor, name, description, config, sha256(config), userId || null]
    )).rows[0];
}

export async function listJuryVersions() {
    return (await pool.query("SELECT * FROM benchmark_jury_versions ORDER BY version_major DESC,version_minor DESC")).rows;
}

export async function getJuryVersion(key) {
    return (await pool.query("SELECT * FROM benchmark_jury_versions WHERE version_key=$1", [key])).rows[0] || null;
}

export async function createRelease({ setupVersionKey, juryVersionKey, name, userId }) {
    const manifest = { setup_version: setupVersionKey, jury_version: juryVersionKey };
    const releaseKey = `${setupVersionKey}-${juryVersionKey}`;
    return (await pool.query(
        `INSERT INTO benchmark_releases (release_key,setup_version_key,jury_version_key,name,manifest_json,manifest_hash,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [releaseKey, setupVersionKey, juryVersionKey, name || releaseKey, manifest, sha256(manifest), userId || null]
    )).rows[0];
}

export async function listReleases() {
    return (await pool.query(
        `SELECT r.*,s.classification,s.name AS setup_name,j.name AS jury_name
         FROM benchmark_releases r JOIN benchmark_setup_versions s ON s.version_key=r.setup_version_key
         JOIN benchmark_jury_versions j ON j.version_key=r.jury_version_key ORDER BY r.created_at DESC`
    )).rows;
}

export async function getRelease(key) {
    return (await pool.query(
        `SELECT r.*,s.manifest_json AS setup_manifest,j.config_json AS jury_config
         FROM benchmark_releases r JOIN benchmark_setup_versions s ON s.version_key=r.setup_version_key
         JOIN benchmark_jury_versions j ON j.version_key=r.jury_version_key WHERE r.release_key=$1`, [key]
    )).rows[0] || null;
}

export async function findDuplicateRun(releaseKey, fingerprint) {
    return (await pool.query(
        `SELECT run_key,status,created_at,finished_at FROM benchmark_runs
         WHERE release_key=$1 AND candidate_fingerprint=$2 AND status IN ('queued','running','completed') ORDER BY created_at DESC LIMIT 1`,
        [releaseKey, fingerprint]
    )).rows[0] || null;
}

export async function bootstrapFixtureVersions({ setupManifest, juryConfig }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const draft = await client.query("SELECT id FROM benchmark_setup_drafts ORDER BY id LIMIT 1");
        if (!draft.rowCount) {
            await client.query(
                `INSERT INTO benchmark_setup_drafts (name,description,config_json)
                 VALUES ('Setup simplificado inicial','Fixtures tecnicos para validar a infraestrutura',$1)`,
                [setupManifest.config || {}]
            );
        }
        await client.query(
            `INSERT INTO benchmark_setup_versions
             (version_key,version_major,version_minor,version_build,name,description,classification,manifest_json,manifest_hash)
             VALUES ('S0.0.1',0,0,1,'Fixtures simplificados','Casos sinteticos nao validados, mantidos para desenvolvimento','fixture',$1,$2)
             ON CONFLICT (version_key) DO NOTHING`,
            [setupManifest, sha256(setupManifest)]
        );
        await client.query(
            `INSERT INTO benchmark_jury_versions
             (version_key,version_major,version_minor,name,description,config_json,manifest_hash)
             VALUES ('J0.1',0,1,'Juiz OpenAI inicial','Conselho tecnico inicial com um juiz',$1,$2)
             ON CONFLICT (version_key) DO NOTHING`,
            [juryConfig, sha256(juryConfig)]
        );
        const releaseManifest = { setup_version: "S0.0.1", jury_version: "J0.1" };
        await client.query(
            `INSERT INTO benchmark_releases
             (release_key,setup_version_key,jury_version_key,name,manifest_json,manifest_hash)
             VALUES ('S0.0.1-J0.1','S0.0.1','J0.1','Benchmark tecnico inicial',$1,$2)
             ON CONFLICT (release_key) DO NOTHING`,
            [releaseManifest, sha256(releaseManifest)]
        );
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally { client.release(); }
}

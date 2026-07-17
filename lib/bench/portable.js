// Export/import portátil de resultados do benchmark entre ambientes.
//
// buildBundle: lê do Postgres local e monta um "super arquivo" JSON auto-contido
// (versões S/J + releases + runs completos com filhos).
// importBundle: grava o bundle no Postgres local de forma idempotente (upsert por
// chave; zera provenance/usuário locais; relinka runs ao que existir).

import { pool } from "../../auth.js";
import { BUNDLE_KIND, BUNDLE_SCHEMA, NULLIFY_ON_IMPORT, buildInsertStatement, validateBundle, summarizeBundle } from "./portableFormat.js";

const uniq = (values) => [...new Set(values.filter((value) => value != null))];

async function selectByKeys(table, column, keys) {
    if (!keys.length) return [];
    return (await pool.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1::text[]) ORDER BY ${column}`, [keys])).rows;
}

async function runChildren(runKey) {
    const [outputs, judgments, consensus, ledger] = await Promise.all([
        pool.query("SELECT * FROM benchmark_model_outputs WHERE run_key=$1 ORDER BY id", [runKey]),
        pool.query("SELECT * FROM benchmark_judgments WHERE run_key=$1 ORDER BY id", [runKey]),
        pool.query("SELECT * FROM benchmark_consensus WHERE run_key=$1 ORDER BY id", [runKey]),
        pool.query("SELECT * FROM benchmark_call_ledger WHERE run_key=$1 ORDER BY id", [runKey]),
    ]);
    return { outputs: outputs.rows, judgments: judgments.rows, consensus: consensus.rows, ledger: ledger.rows };
}

// scope: { all: true } | { releaseKey } | { runKey }
export async function buildBundle(scope = {}) {
    let runRows;
    if (scope.runKey) {
        runRows = (await pool.query("SELECT * FROM benchmark_runs WHERE run_key=$1", [scope.runKey])).rows;
        if (!runRows.length) throw new Error(`run nao encontrado: ${scope.runKey}`);
    } else if (scope.releaseKey) {
        runRows = (await pool.query("SELECT * FROM benchmark_runs WHERE release_key=$1 AND status='completed' ORDER BY created_at", [scope.releaseKey])).rows;
    } else {
        runRows = (await pool.query("SELECT * FROM benchmark_runs WHERE status='completed' ORDER BY created_at")).rows;
    }

    let releases;
    if (scope.all) {
        releases = (await pool.query("SELECT * FROM benchmark_releases ORDER BY release_key")).rows;
    } else {
        const releaseKeys = uniq([...runRows.map((run) => run.release_key), scope.releaseKey]);
        releases = await selectByKeys("benchmark_releases", "release_key", releaseKeys);
    }

    let setupVersions;
    let juryVersions;
    if (scope.all) {
        setupVersions = (await pool.query("SELECT * FROM benchmark_setup_versions ORDER BY version_key")).rows;
        juryVersions = (await pool.query("SELECT * FROM benchmark_jury_versions ORDER BY version_key")).rows;
    } else {
        setupVersions = await selectByKeys("benchmark_setup_versions", "version_key", uniq(releases.map((r) => r.setup_version_key)));
        juryVersions = await selectByKeys("benchmark_jury_versions", "version_key", uniq(releases.map((r) => r.jury_version_key)));
    }

    const runs = [];
    for (const run of runRows) {
        const children = run.status === "completed" ? await runChildren(run.run_key) : { outputs: [], judgments: [], consensus: [], ledger: [] };
        runs.push({ ...run, ...children });
    }

    const bundle = {
        kind: BUNDLE_KIND,
        schema_version: BUNDLE_SCHEMA,
        benchmark: "ORATIA-Bench",
        exported_at: new Date().toISOString(),
        scope: scope.runKey ? { run: scope.runKey } : scope.releaseKey ? { release: scope.releaseKey } : { all: true },
        setup_versions: setupVersions,
        jury_versions: juryVersions,
        releases,
        runs,
    };
    bundle.counts = summarizeBundle(bundle);
    return bundle;
}

async function guardedInsert(client, stmt) {
    await client.query("SAVEPOINT bench_import");
    try {
        const result = await client.query(stmt.text, stmt.values);
        await client.query("RELEASE SAVEPOINT bench_import");
        return result.rowCount === 0 ? "skipped" : "inserted";
    } catch {
        await client.query("ROLLBACK TO SAVEPOINT bench_import");
        return "skipped";
    }
}

export async function importBundle(bundle) {
    validateBundle(bundle);
    const counts = { setup_versions: 0, jury_versions: 0, releases: 0, runs: 0, skipped: 0 };
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        for (const row of bundle.setup_versions) {
            const outcome = await guardedInsert(client, buildInsertStatement("benchmark_setup_versions", row, {
                nullify: NULLIFY_ON_IMPORT.benchmark_setup_versions, conflict: "ON CONFLICT (version_key) DO NOTHING",
            }));
            outcome === "inserted" ? counts.setup_versions++ : counts.skipped++;
        }
        for (const row of bundle.jury_versions) {
            const outcome = await guardedInsert(client, buildInsertStatement("benchmark_jury_versions", row, {
                nullify: NULLIFY_ON_IMPORT.benchmark_jury_versions, conflict: "ON CONFLICT (version_key) DO NOTHING",
            }));
            outcome === "inserted" ? counts.jury_versions++ : counts.skipped++;
        }
        for (const row of bundle.releases) {
            const outcome = await guardedInsert(client, buildInsertStatement("benchmark_releases", row, {
                nullify: NULLIFY_ON_IMPORT.benchmark_releases, conflict: "ON CONFLICT (release_key) DO NOTHING",
            }));
            outcome === "inserted" ? counts.releases++ : counts.skipped++;
        }

        // Quais releases existem no destino (para relinkar runs sem quebrar FK).
        const candidateReleaseKeys = uniq([
            ...bundle.releases.map((r) => r.release_key),
            ...bundle.runs.map((r) => r.release_key),
        ]);
        const existingReleases = new Set(
            candidateReleaseKeys.length
                ? (await client.query("SELECT release_key FROM benchmark_releases WHERE release_key = ANY($1::text[])", [candidateReleaseKeys])).rows.map((r) => r.release_key)
                : []
        );

        for (const run of bundle.runs) {
            const { outputs = [], judgments = [], consensus = [], ledger = [], ...runRow } = run;
            if (runRow.release_key && !existingReleases.has(runRow.release_key)) runRow.release_key = null;
            // Idempotente: apaga o run (cascade nos filhos) e reinsere.
            await client.query("DELETE FROM benchmark_runs WHERE run_key=$1", [run.run_key]);
            await client.query(...toArgs(buildInsertStatement("benchmark_runs", runRow, { drop: [], nullify: NULLIFY_ON_IMPORT.benchmark_runs })));
            for (const row of outputs) await client.query(...toArgs(buildInsertStatement("benchmark_model_outputs", row)));
            for (const row of judgments) await client.query(...toArgs(buildInsertStatement("benchmark_judgments", row)));
            for (const row of consensus) await client.query(...toArgs(buildInsertStatement("benchmark_consensus", row)));
            for (const row of ledger) await client.query(...toArgs(buildInsertStatement("benchmark_call_ledger", row)));
            counts.runs++;
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return counts;
}

function toArgs(stmt) { return [stmt.text, stmt.values]; }

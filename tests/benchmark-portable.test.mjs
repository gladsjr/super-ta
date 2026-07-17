import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BUNDLE_KIND, BUNDLE_SCHEMA, buildInsertStatement, validateBundle, summarizeBundle,
} from "../lib/bench/portableFormat.js";

test("buildInsertStatement dropa id, zera FKs e serializa colunas _json", () => {
    const row = { id: 9, run_key: "r1", config_json: { a: 1 }, created_by: 7, artifact_dir: "/tmp/x", latency_ms: 12 };
    const stmt = buildInsertStatement("benchmark_runs", row, { drop: ["id"], nullify: ["created_by", "artifact_dir"] });
    assert.match(stmt.text, /^INSERT INTO benchmark_runs \(/);
    assert.ok(!stmt.text.includes('"id"'), "id nao deve entrar");
    // ordem preservada: run_key, config_json, created_by, artifact_dir, latency_ms
    assert.deepEqual(stmt.values, ["r1", JSON.stringify({ a: 1 }), null, null, 12]);
    assert.match(stmt.text, /VALUES \(\$1, \$2, \$3, \$4, \$5\)$/);
});

test("buildInsertStatement aplica clausula de conflito", () => {
    const stmt = buildInsertStatement("benchmark_setup_versions", { version_key: "S1", manifest_json: {} }, { conflict: "ON CONFLICT (version_key) DO NOTHING" });
    assert.match(stmt.text, /ON CONFLICT \(version_key\) DO NOTHING$/);
    assert.equal(stmt.values[0], "S1");
    assert.equal(stmt.values[1], "{}");
});

test("buildInsertStatement serializa _json nulo como NULL, nao 'null'", () => {
    const stmt = buildInsertStatement("t", { a_json: null, b: 3 });
    assert.deepEqual(stmt.values, [null, 3]);
});

test("buildInsertStatement rejeita identificadores invalidos", () => {
    assert.throws(() => buildInsertStatement("bad-name", { a: 1 }));
    assert.throws(() => buildInsertStatement("t", { "a; DROP": 1 }));
});

function goodBundle() {
    return {
        kind: BUNDLE_KIND, schema_version: BUNDLE_SCHEMA, benchmark: "ORATIA-Bench",
        setup_versions: [{ version_key: "S1" }], jury_versions: [{ version_key: "J1" }],
        releases: [{ release_key: "S1-J1" }],
        runs: [{ run_key: "r1", outputs: [{}, {}], judgments: [{}], consensus: [], ledger: [{}, {}, {}] }],
    };
}

test("validateBundle aceita bundle bem-formado e retorna-o", () => {
    const bundle = goodBundle();
    assert.equal(validateBundle(bundle), bundle);
});

test("validateBundle rejeita kind errado, arrays ausentes, schema futuro e run sem chave", () => {
    assert.throws(() => validateBundle({ ...goodBundle(), kind: "outro" }), /kind/);
    assert.throws(() => validateBundle({ ...goodBundle(), releases: "x" }), /releases/);
    assert.throws(() => validateBundle({ ...goodBundle(), schema_version: BUNDLE_SCHEMA + 1 }), /mais novo/);
    assert.throws(() => validateBundle({ ...goodBundle(), runs: [{ outputs: [] }] }), /run_key/);
    assert.throws(() => validateBundle(null), /objeto/);
});

test("summarizeBundle conta entidades e filhos", () => {
    assert.deepEqual(summarizeBundle(goodBundle()), {
        setup_versions: 1, jury_versions: 1, releases: 1, runs: 1,
        outputs: 2, judgments: 1, consensus: 0, ledger: 3,
    });
});

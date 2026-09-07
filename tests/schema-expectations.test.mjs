// O schema esperado, derivado das migrations (#375, lib/schemaExpectations.js).
//
// O que se protege: o check de schema do health check NÃO pode acusar ausência
// falsa (um 503 permanente em produção é o pior resultado possível — a
// monitoração vira ruído e alguém a desliga). Cada caso abaixo é uma armadilha
// real das migrations deste repositório.
//
//   node --test -r dotenv/config tests/schema-expectations.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { splitStatements, factsFromStatement, expectedSchema, diffExpected, readMigrationFiles } from "../lib/schemaExpectations.js";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const mig = (filename, sql) => ({ version: filename.slice(0, 3), filename, sql });

test("comentários com ';' e parênteses aninhados não quebram o corte de comandos", () => {
    const sql = `-- cria; não confundir\nCREATE TABLE a (id INT, CONSTRAINT c CHECK (x IN (1, 2)));\nALTER TABLE a ADD COLUMN b TEXT; -- fim;`;
    const st = splitStatements(sql);
    assert.equal(st.length, 2);
    assert.match(st[0], /^CREATE TABLE a/);
    assert.match(st[1], /^ALTER TABLE a ADD COLUMN b TEXT$/);
});

test("ALTER TABLE com várias cláusulas, IF NOT EXISTS e aspas", () => {
    const f = factsFromStatement(`ALTER TABLE "works" ADD COLUMN IF NOT EXISTS a INT, ADD CONSTRAINT works_a_chk CHECK (a IN (1, 2)), DROP COLUMN IF EXISTS b`);
    assert.deepEqual(f.map(x => [x.op, x.kind, x.column || x.name]), [["add", "column", "a"], ["add", "constraint", "works_a_chk"], ["drop", "column", "b"]]);
});

test("objetos fora do schema public (views/functions de analytics, ADR 0014) não viram expectativa", () => {
    assert.deepEqual(factsFromStatement("CREATE TABLE analytics.works AS SELECT 1"), []);
    assert.deepEqual(factsFromStatement("CREATE VIEW analytics.works AS SELECT 1"), []);
    assert.deepEqual(factsFromStatement("CREATE FUNCTION analytics.try_jsonb(t text) RETURNS jsonb AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql"), []);
});

test("DROP COLUMN derruba junto índice e constraint que dependem da coluna (casos 068 e 073)", () => {
    const exp = expectedSchema([
        mig("001_a.sql", `CREATE TABLE users (id INT); ALTER TABLE users ADD COLUMN civil_id_type TEXT, ADD COLUMN civil_id_value TEXT;
            ALTER TABLE users ADD CONSTRAINT users_civil_id_pair_chk CHECK ((civil_id_type IS NULL) = (civil_id_value IS NULL));
            CREATE UNIQUE INDEX users_civil_id_uidx ON users (civil_id_type, civil_id_value) WHERE civil_id_value IS NOT NULL;
            CREATE UNIQUE INDEX users_email_uidx ON users (lower(email));`),
        mig("002_b.sql", `ALTER TABLE users DROP COLUMN civil_id_type; ALTER TABLE users DROP COLUMN civil_id_value;`),
    ]);
    assert.ok(!exp.indexes.has("users_civil_id_uidx"), "índice sobre coluna dropada não pode ser esperado");
    assert.ok(!exp.constraints.has("users.users_civil_id_pair_chk"), "constraint sobre coluna dropada não pode ser esperada");
    assert.ok(exp.indexes.has("users_email_uidx"), "índice de outra coluna fica");
    assert.ok(!exp.columns.has("users.civil_id_type"));
});

test("DROP TABLE leva colunas, índices e constraints; RENAME preserva a migration de origem", () => {
    const exp = expectedSchema([
        mig("001_a.sql", `CREATE TABLE t (id INT); ALTER TABLE t ADD COLUMN c INT; CREATE INDEX t_c_idx ON t (c); ALTER TABLE t ADD CONSTRAINT t_chk CHECK (c > 0);`),
        mig("002_b.sql", `ALTER TABLE t RENAME COLUMN c TO d; ALTER TABLE t RENAME TO u;`),
        mig("003_c.sql", `CREATE TABLE lixo (id INT); CREATE INDEX lixo_idx ON lixo (id); DROP TABLE lixo;`),
    ]);
    assert.equal(exp.tables.get("u"), "001_a.sql");
    assert.equal(exp.columns.get("u.d"), "001_a.sql");
    assert.equal(exp.indexes.get("t_c_idx").table, "u");
    assert.ok(exp.constraints.has("u.t_chk"));
    assert.ok(!exp.tables.has("lixo") && !exp.indexes.has("lixo_idx"));
});

test("o diff acusa a ausência com a migration de origem, e não repete a tabela nas colunas", () => {
    const exp = expectedSchema([
        mig("079_a.sql", `CREATE TABLE jobs (id INT); CREATE INDEX jobs_idx ON jobs (id);`),
        mig("080_b.sql", `CREATE TABLE object_sizes (key TEXT); ALTER TABLE submissions ADD COLUMN x INT;`),
    ]);
    const catalog = { tables: new Set(["jobs", "submissions"]), columns: new Set(["jobs.id"]), indexes: new Set(), constraints: new Set() };
    const missing = diffExpected(exp, catalog);
    assert.deepEqual(missing.map(m => [m.kind, m.name, m.migration]).sort(), [
        ["column", "submissions.x", "080_b.sql"],
        ["index", "jobs_idx", "079_a.sql"],
        ["table", "object_sizes", "080_b.sql"],
    ]);
});

test("as migrations reais produzem expectativa não trivial e só três arquivos sem fato estrutural", () => {
    const exp = expectedSchema(readMigrationFiles(path.join(raiz, "migrations")));
    assert.ok(exp.tables.size >= 40 && exp.columns.size >= 100 && exp.indexes.size >= 40 && exp.constraints.size >= 10, JSON.stringify({ t: exp.tables.size, c: exp.columns.size, i: exp.indexes.size, k: exp.constraints.size }));
    // Migrations só de dados/ALTER COLUMN: conhecidas. Uma nova aqui merece um
    // olhar — pode ser gramática que o parser não entende.
    assert.deepEqual(exp.withoutFacts, ["039_migrate_oral_rubric.sql", "046_reset_benchmark_case_schema_v3.sql", "071_question_count_default_5.sql"]);
});

test("colunas e constraints declaradas DENTRO do CREATE TABLE entram na expectativa (migration 080 real)", () => {
    // Regressão apontada na revisão do #388: o parser só pegava o nome da
    // tabela, e uma coluna ausente de uma tabela criada inteira numa migration
    // passava verde. Constraint sem nome recebe o nome que o Postgres dá.
    const exp = expectedSchema(readMigrationFiles(path.join(raiz, "migrations")));
    for (const c of ["object_sizes.object_key", "object_sizes.bytes", "object_sizes.created_at"]) {
        assert.equal(exp.columns.get(c), "080_object_sizes.sql", `faltou a coluna ${c}`);
    }
    assert.equal(exp.constraints.get("object_sizes.object_sizes_pkey")?.migration, "080_object_sizes.sql");
    assert.equal(exp.constraints.get("object_sizes.object_sizes_bytes_check")?.migration, "080_object_sizes.sql");
    const catalog = {
        tables: new Set(exp.tables.keys()),
        columns: new Set([...exp.columns.keys()].filter(c => c !== "object_sizes.bytes")),
        indexes: new Set(exp.indexes.keys()),
        constraints: new Set([...exp.constraints.keys()].filter(c => c !== "object_sizes.object_sizes_bytes_check")),
    };
    assert.deepEqual(diffExpected(exp, catalog).map(m => [m.kind, m.name, m.migration]).sort(), [
        ["column", "object_sizes.bytes", "080_object_sizes.sql"],
        ["constraint", "object_sizes.object_sizes_bytes_check", "080_object_sizes.sql"],
    ]);
});

test("constraint sem nome recebe o nome que o Postgres dá — e ADD CHECK não vira coluna chamada 'check'", () => {
    const f = factsFromStatement("ALTER TABLE works ADD CHECK (question_count BETWEEN 3 AND 10)");
    assert.ok(!f.some(x => x.kind === "column"), JSON.stringify(f));
    const exp = expectedSchema([mig("001_a.sql", `
        CREATE TABLE pa (id INT PRIMARY KEY, granted INT NOT NULL CHECK (granted >= 0), delegated INT, unit_id INT REFERENCES units(id), code TEXT UNIQUE,
                         CHECK (delegated <= granted), UNIQUE (unit_id, code));
        ALTER TABLE pa ADD CHECK (delegated >= 0);
        ALTER TABLE pa ADD COLUMN mode TEXT CHECK (mode IN ('a', 'b'));
        ALTER TABLE pa ADD COLUMN owner_id INT REFERENCES users(id);`)]);
    assert.deepEqual([...exp.constraints.keys()].sort(), [
        "pa.pa_check",                 // duas colunas na expressão → sem coluna no nome
        "pa.pa_code_key",
        "pa.pa_delegated_check",       // ADD CHECK sem nome, uma coluna
        "pa.pa_granted_check",
        "pa.pa_mode_check",            // inline no ADD COLUMN
        "pa.pa_owner_id_fkey",         // REFERENCES inline no ADD COLUMN
        "pa.pa_pkey",
        "pa.pa_unit_id_code_key",
        "pa.pa_unit_id_fkey",
    ]);
});

test("dois CHECK sem nome na mesma coluna: o segundo ganha sufixo 1, como no Postgres", () => {
    const exp = expectedSchema([mig("001_a.sql", `CREATE TABLE t (a INT CHECK (a > 0)); ALTER TABLE t ADD CHECK (a < 100);`)]);
    assert.deepEqual([...exp.constraints.keys()].sort(), ["t.t_a_check", "t.t_a_check1"]);
});

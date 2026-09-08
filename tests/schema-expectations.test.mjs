// O schema esperado, derivado das migrations (#375, lib/schemaExpectations.js).
//
// O que se protege: o check de schema do health check NÃO pode acusar ausência
// falsa (um 503 permanente em produção é o pior resultado possível — a
// monitoração vira ruído e alguém a desliga). E a convenção que o mantém
// simples — constraint e índice com NOME explícito nas migrations novas — é
// verificada aqui, não só escrita no AGENTS.md.
//
//   node --test -r dotenv/config tests/schema-expectations.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { splitStatements, factsFromStatement, expectedSchema, afterBaseline, diffExpected, readMigrationFiles, SCHEMA_BASELINE } from "../lib/schemaExpectations.js";

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

test("CREATE TABLE por dentro: colunas, PRIMARY KEY inline na coluna e constraints NOMEADAS entram; sem nome vira aviso, não expectativa", () => {
    const exp = expectedSchema([mig("081_a.sql", `
        CREATE TABLE t (id SERIAL PRIMARY KEY, a INT NOT NULL, b TEXT CONSTRAINT t_b_chk CHECK (b <> ''), c INT CHECK (c > 0), d INT REFERENCES u(id),
                        CONSTRAINT t_a_uq UNIQUE (a), UNIQUE (b, c));
        CREATE TABLE v (id INT, PRIMARY KEY (id));
        CREATE INDEX ON t (a);`)]);
    assert.deepEqual([...exp.columns.keys()].sort(), ["t.a", "t.b", "t.c", "t.d", "t.id", "v.id"]);
    assert.deepEqual([...exp.constraints.keys()].sort(), ["t.t_a_uq", "t.t_b_chk", "t.t_pkey"]);
    // PRIMARY KEY de TABELA sem nome e CREATE INDEX sem nome ferem a convenção
    assert.deepEqual(exp.unnamed.map(u => `${u.table}:${u.what}`).sort(), ["t:CHECK", "t:INDEX", "t:REFERENCES", "t:UNIQUE", "v:PRIMARY"]);
    assert.ok(exp.unnamed.every(u => u.migration === "081_a.sql"));
    assert.equal(exp.indexes.size, 0, "índice sem nome não vira expectativa (não se inventa nome)");
});

test("RENAME depois da linha de base: o nome novo é esperado pela migration do rename", () => {
    // Revisão do #391: preservar a origem antiga apagava a alteração nova do
    // filtro — um rename que o Publish deixasse para trás passaria verde.
    const full = expectedSchema([
        mig("079_a.sql", `CREATE TABLE t (id INT, c INT); CREATE INDEX t_c_idx ON t (c); ALTER TABLE t ADD CONSTRAINT t_c_chk CHECK (c > 0);`),
        mig("082_r.sql", `ALTER TABLE t RENAME COLUMN c TO d; ALTER TABLE t RENAME TO u;`),
    ]);
    const exp = afterBaseline(full, "080");
    assert.equal(exp.tables.get("u"), "082_r.sql");
    assert.deepEqual([...exp.columns.keys()].sort(), ["u.d", "u.id"]);
    assert.equal(exp.constraints.get("u.t_c_chk").migration, "082_r.sql");
    assert.equal(exp.indexes.get("t_c_idx").migration, "082_r.sql");
    // catálogo ANTIGO (rename não materializado): tudo acusado
    const antigo = { tables: new Set(["t"]), columns: new Set(["t.id", "t.c"]), indexes: new Set(["t_c_idx"]), constraints: new Set(["t.t_c_chk"]) };
    assert.deepEqual(diffExpected(exp, antigo).map(m => [m.kind, m.name]), [["table", "u"]]);
    // só o rename de coluna deixado para trás
    const soColuna = { tables: new Set(["u"]), columns: new Set(["u.id", "u.c"]), indexes: new Set(["t_c_idx"]), constraints: new Set(["u.t_c_chk"]) };
    assert.deepEqual(diffExpected(exp, soColuna).map(m => [m.kind, m.name, m.migration]), [["column", "u.d", "082_r.sql"]]);
});

test("tabela anterior à linha de base ausente não esconde o objeto novo dela: vira ausência de tabela, uma vez", () => {
    const full = expectedSchema([
        mig("079_a.sql", `CREATE TABLE t (id INT);`),
        mig("082_n.sql", `ALTER TABLE t ADD COLUMN x INT, ADD COLUMN y INT; CREATE INDEX t_x_idx ON t (x);`),
    ]);
    const exp = afterBaseline(full, "080");
    assert.equal(exp.tables.size, 0, "t é anterior à linha de base: não é esperada por si");
    const semT = { tables: new Set(), columns: new Set(), indexes: new Set(), constraints: new Set() };
    const missing = diffExpected(exp, semT);
    assert.deepEqual(missing.map(m => [m.kind, m.name, m.migration]), [["table", "t", "082_n.sql"]]);
    assert.match(missing[0].note, /anterior à linha de base/);
});

test("ADD COLUMN com REFERENCES/CHECK inline e ADD CHECK solto: coluna entra, o sem nome vira aviso", () => {
    const exp = expectedSchema([mig("081_a.sql", `CREATE TABLE t (id INT); ALTER TABLE t ADD COLUMN x INT REFERENCES u(id); ALTER TABLE t ADD CHECK (x > 0);
        ALTER TABLE t ADD COLUMN y INT, ADD CONSTRAINT t_y_fk FOREIGN KEY (y) REFERENCES u(id);`)]);
    assert.deepEqual([...exp.columns.keys()].sort(), ["t.id", "t.x", "t.y"]);
    assert.deepEqual([...exp.constraints.keys()], ["t.t_y_fk"]);
    assert.deepEqual(exp.unnamed.map(u => u.what).sort(), ["CHECK", "REFERENCES"]);
    assert.ok(!exp.columns.has("t.check"), "ADD CHECK não é coluna");
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

test("DROP TABLE leva colunas, índices e constraints; RENAME move tudo para o nome novo, atribuído à migration do rename", () => {
    const exp = expectedSchema([
        mig("001_a.sql", `CREATE TABLE t (id INT); ALTER TABLE t ADD COLUMN c INT; CREATE INDEX t_c_idx ON t (c); ALTER TABLE t ADD CONSTRAINT t_chk CHECK (c > 0);`),
        mig("002_b.sql", `ALTER TABLE t RENAME COLUMN c TO d; ALTER TABLE t RENAME TO u;`),
        mig("003_c.sql", `CREATE TABLE lixo (id INT); CREATE INDEX lixo_idx ON lixo (id); DROP TABLE lixo;`),
    ]);
    assert.equal(exp.tables.get("u"), "002_b.sql", "o nome novo é obra do rename");
    assert.equal(exp.columns.get("u.d"), "002_b.sql");
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
    assert.deepEqual(diffExpected(exp, catalog).map(m => [m.kind, m.name, m.migration]).sort(), [
        ["column", "submissions.x", "080_b.sql"],
        ["index", "jobs_idx", "079_a.sql"],
        ["table", "object_sizes", "080_b.sql"],
    ]);
});

test("linha de base: só o que veio DEPOIS dela é esperado, mas o replay (DROP/RENAME) continua completo", () => {
    const full = expectedSchema([
        mig("079_a.sql", `CREATE TABLE velha (id INT, x INT); CREATE INDEX velha_x_idx ON velha (x);`),
        mig("081_b.sql", `ALTER TABLE velha DROP COLUMN x; ALTER TABLE velha ADD COLUMN y INT; CREATE TABLE nova (id INT PRIMARY KEY);`),
    ]);
    const exp = afterBaseline(full, "080");
    assert.deepEqual([...exp.tables.keys()], ["nova"]);
    assert.deepEqual([...exp.columns.keys()].sort(), ["nova.id", "velha.y"]);
    assert.deepEqual([...exp.constraints.keys()], ["nova.nova_pkey"]);
    assert.equal(exp.indexes.size, 0, "o índice da 079 dropado com a coluna não volta pela porta dos fundos");
    assert.equal(exp.baseline, "080");
});

test("migrations reais: o replay completo é coerente, e a linha de base é a 080", () => {
    const full = expectedSchema(readMigrationFiles(path.join(raiz, "migrations")));
    assert.ok(full.tables.size >= 45 && full.columns.size >= 480, JSON.stringify({ t: full.tables.size, c: full.columns.size }));
    assert.deepEqual(full.withoutFacts, ["039_migrate_oral_rubric.sql", "046_reset_benchmark_case_schema_v3.sql", "071_question_count_default_5.sql"]);
    assert.equal(SCHEMA_BASELINE, "080");
    const exp = afterBaseline(full);
    // A 081 renomeia a FK da 074 (#389): é o primeiro objeto conferido pelo check.
    assert.equal(exp.constraints.get("submissions.submissions_proctor_review_level_fkey")?.migration, "081_rename_proctor_review_fkey.sql");
    assert.ok(!exp.constraints.has("submissions.submissions_proctor_review_fkey"), "o nome antigo foi dropado");
});

test("CONVENÇÃO: migration posterior à linha de base não cria constraint sem nome (AGENTS.md)", () => {
    // Objeto sem nome não é conferido pelo health check — e o Publish já
    // deixou constraint para trás (074). Quem quebrar isto vê a migration e o
    // comando aqui, antes do PR.
    const exp = afterBaseline(expectedSchema(readMigrationFiles(path.join(raiz, "migrations"))));
    assert.deepEqual(exp.unnamed, [], "constraint sem nome em migration nova:\n" + exp.unnamed.map(u => `  ${u.migration} (${u.table}): ${u.def}`).join("\n"));
});

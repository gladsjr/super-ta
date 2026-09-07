// O que o schema DEVERIA ter, derivado dos arquivos de migration (#375).
//
// Por que isto existe: em produção o ledger `schema_migrations` NÃO é fonte de
// verdade. O Publish do Replit materializa o schema por diff dev→prod e não
// escreve uma linha no ledger (ADR 0001) — medido em 07/09/2026: prod tinha 8
// linhas no ledger e 80 migrations materializadas. Um check que lê o ledger
// acusaria 72 "pendentes" para sempre. O que se quer saber depois de um
// Publish é outra coisa: "as tabelas, colunas, índices e constraints que as
// migrations criaram EXISTEM neste banco?". Isto responde olhando o catálogo.
//
// Como: lê cada migration em ordem, extrai os fatos estruturais que ela cria
// ou remove (CREATE TABLE, ADD COLUMN, CREATE INDEX, ADD CONSTRAINT e os
// respectivos DROPs) e acumula o estado final esperado, com a migration que
// introduziu cada objeto — é ela que aparece no relatório quando falta algo.
//
// O que NÃO cobre, de propósito:
//   - Mudança de TIPO/DEFAULT/NOT NULL (ALTER COLUMN) e a DEFINIÇÃO de uma
//     constraint: o diff do Publish compara constraint por NOME, e este check
//     também — trocar a definição mantendo o nome passa verde nos dois
//     (.agents/memory/replit-publish-vs-boot-migrations.md, caso 022→029).
//   - Objetos fora do schema public (views/functions do schema `analytics`,
//     abandonados na 054): o Publish não os propaga e nada depende deles
//     (ADR 0014).
//   - Dados (INSERT/UPDATE de seeds): são do check de seeds.
//
// Parser deliberadamente pequeno: cobre a gramática que as migrations deste
// repositório usam (levantada nos 80 arquivos), não SQL em geral. Um comando
// que ele não entende é ignorado — nunca vira expectativa falsa.

import fs from "node:fs";
import path from "node:path";

const ident = (s) => String(s).replace(/"/g, "").toLowerCase();

// Remove comentários `--` e divide em comandos pelo `;` fora de aspas/parênteses
// (o corpo de uma function tem `;` dentro de $$...$$ — está fora do escopo,
// mas o corte por profundidade evita que um `$$` engula o arquivo inteiro).
export function splitStatements(sql) {
    const semComentarios = sql.replace(/--[^\n]*/g, "");
    const out = [];
    let atual = "", prof = 0, aspas = null, dollar = false;
    for (let i = 0; i < semComentarios.length; i++) {
        const ch = semComentarios[i];
        if (dollar) { atual += ch; if (semComentarios.startsWith("$$", i)) { dollar = false; atual += "$"; i++; } continue; }
        if (aspas) { atual += ch; if (ch === aspas) aspas = null; continue; }
        if (ch === "'" || ch === '"') { aspas = ch; atual += ch; continue; }
        if (semComentarios.startsWith("$$", i)) { dollar = true; atual += "$$"; i++; continue; }
        if (ch === "(") prof++;
        if (ch === ")") prof--;
        if (ch === ";" && prof === 0) { out.push(atual.trim()); atual = ""; continue; }
        atual += ch;
    }
    if (atual.trim()) out.push(atual.trim());
    return out.filter(Boolean).map(s => s.replace(/\s+/g, " "));
}

// Divide as cláusulas de um ALTER TABLE por vírgula de nível zero
// (`ADD COLUMN a INT, ADD CONSTRAINT c CHECK (x IN (1, 2))`).
function clausulas(corpo) {
    const out = [];
    let atual = "", prof = 0;
    for (const ch of corpo) {
        if (ch === "(") prof++;
        if (ch === ")") prof--;
        if (ch === "," && prof === 0) { out.push(atual.trim()); atual = ""; continue; }
        atual += ch;
    }
    if (atual.trim()) out.push(atual.trim());
    return out;
}

// Nome qualificado com schema (`analytics.works`) fica fora do escopo.
const foraDoPublic = (nome) => nome.includes(".");

// Extrai os fatos de UM comando. Devolve lista de {op, kind, ...}.
export function factsFromStatement(stmt) {
    const s = stmt.trim();
    let m;
    if ((m = /^CREATE TABLE (?:IF NOT EXISTS )?("?[\w.]+"?)/i.exec(s))) {
        const table = ident(m[1]);
        return foraDoPublic(table) ? [] : [{ op: "add", kind: "table", table }];
    }
    if ((m = /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?("?[\w.]+"?) ON (?:ONLY )?("?[\w.]+"?)(.*)$/i.exec(s))) {
        const name = ident(m[1]), table = ident(m[2]);
        return (foraDoPublic(name) || foraDoPublic(table)) ? [] : [{ op: "add", kind: "index", name, table, def: m[3] }];
    }
    if ((m = /^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?("?[\w.]+"?)/i.exec(s))) {
        return [{ op: "drop", kind: "index", name: ident(m[1]) }];
    }
    if ((m = /^DROP TABLE (?:IF EXISTS )?("?[\w.]+"?)/i.exec(s))) {
        return [{ op: "drop", kind: "table", table: ident(m[1]) }];
    }
    if ((m = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?("?[\w.]+"?) (.+)$/i.exec(s))) {
        const table = ident(m[1]);
        if (foraDoPublic(table)) return [];
        const fatos = [];
        for (const c of clausulas(m[2])) {
            let k;
            if ((k = /^ADD CONSTRAINT ("?\w+"?)(.*)$/i.exec(c))) fatos.push({ op: "add", kind: "constraint", name: ident(k[1]), table, def: k[2] });
            else if ((k = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?("?\w+"?)/i.exec(c))) fatos.push({ op: "add", kind: "column", table, column: ident(k[1]) });
            else if ((k = /^DROP CONSTRAINT (?:IF EXISTS )?("?\w+"?)/i.exec(c))) fatos.push({ op: "drop", kind: "constraint", name: ident(k[1]), table });
            else if ((k = /^DROP (?:COLUMN )?(?:IF EXISTS )?("?\w+"?)/i.exec(c))) fatos.push({ op: "drop", kind: "column", table, column: ident(k[1]) });
            else if ((k = /^RENAME (?:COLUMN )?("?\w+"?) TO ("?\w+"?)/i.exec(c))) fatos.push({ op: "rename", kind: "column", table, from: ident(k[1]), to: ident(k[2]) });
            else if ((k = /^RENAME TO ("?\w+"?)/i.exec(c))) fatos.push({ op: "rename", kind: "table", from: table, to: ident(k[1]) });
            // ALTER COLUMN, SET/DROP DEFAULT, VALIDATE etc.: sem expectativa estrutural.
        }
        return fatos;
    }
    return [];
}

// Acumula o estado final esperado, replicando os fatos migration a migration.
// `files`: [{ version, filename, sql }] em ordem.
export function expectedSchema(files) {
    const tables = new Map();      // table -> migration
    const columns = new Map();     // "table.column" -> migration
    const indexes = new Map();     // index -> { table, migration, def }
    const constraints = new Map(); // "table.name" -> { migration, def }
    const semFatos = [];

    for (const f of files) {
        const fatos = splitStatements(f.sql).flatMap(factsFromStatement);
        if (!fatos.length) semFatos.push(f.filename);
        for (const x of fatos) {
            if (x.kind === "table" && x.op === "add") tables.set(x.table, f.filename);
            else if (x.kind === "table" && x.op === "drop") {
                tables.delete(x.table);
                for (const k of [...columns.keys()]) if (k.startsWith(x.table + ".")) columns.delete(k);
                for (const k of [...constraints.keys()]) if (k.startsWith(x.table + ".")) constraints.delete(k);
                for (const [k, v] of [...indexes]) if (v.table === x.table) indexes.delete(k);
            } else if (x.kind === "table" && x.op === "rename") {
                const mig = tables.get(x.from) ?? f.filename;
                tables.delete(x.from); tables.set(x.to, mig);
                for (const [k, v] of [...columns]) if (k.startsWith(x.from + ".")) { columns.delete(k); columns.set(x.to + k.slice(x.from.length), v); }
                for (const [k, v] of [...constraints]) if (k.startsWith(x.from + ".")) { constraints.delete(k); constraints.set(x.to + k.slice(x.from.length), v); }
                for (const v of indexes.values()) if (v.table === x.from) v.table = x.to;
            } else if (x.kind === "column" && x.op === "add") columns.set(`${x.table}.${x.column}`, f.filename);
            else if (x.kind === "column" && x.op === "drop") {
                columns.delete(`${x.table}.${x.column}`);
                // O Postgres derruba junto todo índice e constraint que dependa
                // da coluna (caso real: 073 dropou `invites.token` e levou
                // `invites_token_idx`; 068 dropou os civil_id de users e levou
                // índice + CHECK da 057). Critério por menção do nome na
                // definição — pode remover a mais, nunca cria expectativa falsa.
                const menciona = new RegExp("\\b" + x.column + "\\b", "i");
                for (const [k, v] of [...indexes]) if (v.table === x.table && menciona.test(v.def || "")) indexes.delete(k);
                for (const [k, v] of [...constraints]) if (k.startsWith(x.table + ".") && menciona.test(v.def || "")) constraints.delete(k);
            }
            else if (x.kind === "column" && x.op === "rename") {
                const mig = columns.get(`${x.table}.${x.from}`) ?? f.filename;
                columns.delete(`${x.table}.${x.from}`); columns.set(`${x.table}.${x.to}`, mig);
            } else if (x.kind === "index" && x.op === "add") indexes.set(x.name, { table: x.table, migration: f.filename, def: x.def });
            else if (x.kind === "index" && x.op === "drop") indexes.delete(x.name);
            else if (x.kind === "constraint" && x.op === "add") constraints.set(`${x.table}.${x.name}`, { migration: f.filename, def: x.def });
            else if (x.kind === "constraint" && x.op === "drop") constraints.delete(`${x.table}.${x.name}`);
        }
    }
    return { tables, columns, indexes, constraints, withoutFacts: semFatos };
}

export function readMigrationFiles(dir) {
    return fs.readdirSync(dir)
        .filter(f => /^\d{3}_.+\.sql$/i.test(f))
        .sort()
        .map(filename => ({ version: filename.slice(0, 3), filename, sql: fs.readFileSync(path.join(dir, filename), "utf8") }));
}

// Compara o esperado com o catálogo vivo. `catalog`: { tables:Set, columns:Set
// ("table.column"), indexes:Set, constraints:Set ("table.name") }.
// Devolve os objetos ausentes, cada um com a migration que o introduziu.
export function diffExpected(expected, catalog) {
    const missing = [];
    for (const [t, mig] of expected.tables) if (!catalog.tables.has(t)) missing.push({ kind: "table", name: t, migration: mig });
    for (const [c, mig] of expected.columns) {
        const [t] = c.split(".");
        if (!catalog.tables.has(t)) continue; // a tabela inteira já foi acusada
        if (!catalog.columns.has(c)) missing.push({ kind: "column", name: c, migration: mig });
    }
    for (const [i, v] of expected.indexes) {
        if (!catalog.tables.has(v.table)) continue;
        if (!catalog.indexes.has(i)) missing.push({ kind: "index", name: i, migration: v.migration });
    }
    for (const [c, v] of expected.constraints) {
        const [t] = c.split(".");
        if (!catalog.tables.has(t)) continue;
        if (!catalog.constraints.has(c)) missing.push({ kind: "constraint", name: c, migration: v.migration });
    }
    return missing;
}

// As quatro consultas ao catálogo, prontas para rodar por qualquer executor de
// SQL somente-leitura (o pool do app, ou o endpoint de análise contra prod).
export const CATALOG_SQL = {
    tables: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    columns: `SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = 'public'`,
    indexes: `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'`,
    constraints: `SELECT c.relname || '.' || con.conname AS name FROM pg_constraint con
                  JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public'`,
};

// Monta o catálogo a partir de um executor `q(sql) -> { rows }`.
export async function readCatalog(q) {
    const cat = {};
    for (const [k, sql] of Object.entries(CATALOG_SQL)) {
        const r = await q(sql);
        cat[k] = new Set(r.rows.map(x => String(x.name).toLowerCase()));
    }
    return cat;
}

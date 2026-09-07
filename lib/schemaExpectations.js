// O que o schema DEVERIA ter, derivado dos arquivos de migration (#375).
//
// Por que isto existe: em produção o ledger `schema_migrations` NÃO é fonte de
// verdade. O Publish do Replit materializa o schema por diff dev→prod e não
// escreve uma linha no ledger (ADR 0001) — medido em 07/09/2026: prod tinha 8
// linhas no ledger e 80 migrations materializadas. E o diff já deixou objeto
// para trás em silêncio duas vezes (constraint redefinida com o mesmo nome,
// caso 022→029; FK para coluna UNIQUE, caso 074/#389). O que se quer saber
// depois de um Publish é: "o que as migrations novas criaram EXISTE no banco?"
//
// Como: lê cada migration em ordem, extrai os fatos estruturais que ela cria
// ou remove e acumula o estado final esperado, com a migration que introduziu
// cada objeto — é ela que aparece no relatório quando falta algo.
//
// LINHA DE BASE. O histórico até a migration 080 foi validado uma vez, contra
// dev e contra produção (07/09/2026), e a única divergência virou a migration
// 081. Daí em diante o passado é estado conhecido: o health check confere só
// o que as migrations POSTERIORES à linha de base criam. Cada Publish novo é
// verificado; o histórico não é reprocessado, e o parser só precisa entender
// as migrations novas — que seguem a convenção abaixo.
//
// CONVENÇÃO (AGENTS.md, seção de migrations): toda constraint e todo índice
// em migration nova recebem NOME explícito. Consequência aqui: o parser não
// emula as regras de nomenclatura automática do Postgres — quem escreve
// `CHECK (...)` sem nome não tem esse objeto conferido, e um teste acusa.
//
// O que NÃO cobre, de propósito:
//   - Mudança de TIPO/DEFAULT/NOT NULL (ALTER COLUMN) e a DEFINIÇÃO de uma
//     constraint: o diff do Publish compara constraint por NOME, e este check
//     também — trocar a definição mantendo o nome passa verde nos dois.
//   - Objetos fora do schema public (ADR 0014) e dados (seeds).
//
// Um comando que o parser não entende é ignorado — nunca vira expectativa
// falsa. Alarme falso é o pior resultado possível: monitoração que grita para
// sempre é monitoração desligada.

import fs from "node:fs";
import path from "node:path";

// Migrations com versão MAIOR que esta entram no check. Mude só com uma nova
// validação completa do histórico contra produção.
export const SCHEMA_BASELINE = "080";

const ident = (s) => String(s).replace(/"/g, "").toLowerCase();

// Remove comentários `--` e divide em comandos pelo `;` fora de aspas/parênteses
// (um `$$...$$` de function não é cortado no meio).
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

// Divide cláusulas por vírgula de nível zero (`ADD COLUMN a INT, ADD CONSTRAINT
// c CHECK (x IN (1, 2))`).
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

// Conteúdo do primeiro grupo (...) de nível zero a partir de `de`.
function corpoParentesado(s, de) {
    const ini = s.indexOf("(", de);
    if (ini < 0) return null;
    let prof = 0;
    for (let i = ini; i < s.length; i++) {
        if (s[i] === "(") prof++;
        if (s[i] === ")" && --prof === 0) return s.slice(ini + 1, i);
    }
    return null;
}

// Nome qualificado com schema (`analytics.works`) fica fora do escopo.
const foraDoPublic = (nome) => nome.includes(".");

// Constraint de tabela ou de coluna SEM nome? (o que a convenção proíbe)
const SEM_NOME = /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)\b/i;

// Uma definição de COLUNA (no CREATE TABLE ou no ADD COLUMN): a coluna e as
// constraints inline NOMEADAS. Inline sem nome vira `unnamed` para o teste
// da convenção acusar; não vira expectativa.
function fatosDeColuna(table, clausula) {
    const m = /^("?[A-Za-z_]\w*"?)\s*(.*)$/.exec(clausula);
    if (!m) return [];
    const column = ident(m[1]);
    const fatos = [{ op: "add", kind: "column", table, column }];
    let resto = m[2].replace(/'[^']*'/g, " ");
    resto = resto.replace(/\bCONSTRAINT ("?\w+"?)\s+(PRIMARY KEY|UNIQUE|CHECK|REFERENCES)/gi, (_, nome) => {
        fatos.push({ op: "add", kind: "constraint", table, name: ident(nome), def: clausula });
        return " __NOMEADA__ ";
    });
    // PRIMARY KEY inline NA COLUNA (`id SERIAL PRIMARY KEY`) é universal e
    // sempre se chama {t}_pkey — é a única exceção da convenção. Os outros
    // sem nome (e o PRIMARY KEY de tabela, `PRIMARY KEY (id)`) ferem-na.
    if (/\bPRIMARY KEY\b/i.test(resto)) fatos.push({ op: "add", kind: "constraint", table, name: `${table}_pkey`, def: clausula });
    for (const kw of ["UNIQUE", "CHECK", "REFERENCES"]) {
        if (new RegExp(`\\b${kw}\\b`, "i").test(resto)) fatos.push({ kind: "unnamed", table, column, what: kw, def: clausula });
    }
    return fatos;
}

// Extrai os fatos de UM comando. Devolve lista de {op, kind, ...}.
export function factsFromStatement(stmt) {
    const s = stmt.trim();
    let m;
    if ((m = /^CREATE TABLE (?:IF NOT EXISTS )?("?[\w.]+"?)/i.exec(s))) {
        const table = ident(m[1]);
        if (foraDoPublic(table)) return [];
        const fatos = [{ op: "add", kind: "table", table }];
        const corpo = /^CREATE TABLE (?:IF NOT EXISTS )?"?[\w.]+"?\s*\(/i.test(s) ? corpoParentesado(s, m[0].length) : null;
        if (corpo) {
            for (const c of clausulas(corpo)) {
                let k;
                if ((k = /^CONSTRAINT ("?\w+"?)\s+(.*)$/i.exec(c))) fatos.push({ op: "add", kind: "constraint", table, name: ident(k[1]), def: k[2] });
                else if (SEM_NOME.test(c)) fatos.push({ kind: "unnamed", table, what: c.split(" ")[0].toUpperCase(), def: c });
                else if (!/^LIKE\b/i.test(c)) fatos.push(...fatosDeColuna(table, c));
            }
        }
        return fatos;
    }
    if ((m = /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?ON (?:ONLY )?("?[\w.]+"?)/i.exec(s))) {
        // `CREATE INDEX ON t (c)` é válido e sem nome: fere a convenção.
        return foraDoPublic(ident(m[1])) ? [] : [{ kind: "unnamed", table: ident(m[1]), what: "INDEX", def: s }];
    }
    if ((m = /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?("?[\w.]+"?) ON (?:ONLY )?("?[\w.]+"?)(.*)$/i.exec(s))) {
        const name = ident(m[1]), table = ident(m[2]);
        return (foraDoPublic(name) || foraDoPublic(table)) ? [] : [{ op: "add", kind: "index", name, table, def: m[3] }];
    }
    if ((m = /^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?("?[\w.]+"?)/i.exec(s))) return [{ op: "drop", kind: "index", name: ident(m[1]) }];
    if ((m = /^DROP TABLE (?:IF EXISTS )?("?[\w.]+"?)/i.exec(s))) return [{ op: "drop", kind: "table", table: ident(m[1]) }];
    if ((m = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?("?[\w.]+"?) (.+)$/i.exec(s))) {
        const table = ident(m[1]);
        if (foraDoPublic(table)) return [];
        const fatos = [];
        for (const c of clausulas(m[2])) {
            let k;
            if ((k = /^ADD CONSTRAINT ("?\w+"?)(.*)$/i.exec(c))) fatos.push({ op: "add", kind: "constraint", name: ident(k[1]), table, def: k[2] });
            else if (/^ADD (PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)\b/i.test(c)) fatos.push({ kind: "unnamed", table, what: c.replace(/^ADD /i, "").split(" ")[0].toUpperCase(), def: c });
            else if ((k = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(.+)$/i.exec(c))) fatos.push(...fatosDeColuna(table, k[1]));
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
// `files`: [{ version, filename, sql }] em ordem. Devolve também `unnamed`:
// constraints sem nome encontradas, por migration (para o teste da convenção).
export function expectedSchema(files) {
    const tables = new Map();      // table -> migration
    const columns = new Map();     // "table.column" -> migration
    const indexes = new Map();     // index -> { table, migration, def }
    const constraints = new Map(); // "table.name" -> { migration, def }
    const semFatos = [];
    const unnamed = [];

    for (const f of files) {
        const fatos = splitStatements(f.sql).flatMap(factsFromStatement);
        if (!fatos.length) semFatos.push(f.filename);
        for (const x of fatos) {
            if (x.kind === "unnamed") { unnamed.push({ migration: f.filename, table: x.table, what: x.what, def: x.def }); continue; }
            if (x.kind === "table" && x.op === "add") tables.set(x.table, f.filename);
            else if (x.kind === "table" && x.op === "drop") {
                tables.delete(x.table);
                for (const k of [...columns.keys()]) if (k.startsWith(x.table + ".")) columns.delete(k);
                for (const k of [...constraints.keys()]) if (k.startsWith(x.table + ".")) constraints.delete(k);
                for (const [k, v] of [...indexes]) if (v.table === x.table) indexes.delete(k);
            } else if (x.kind === "table" && x.op === "rename") {
                // O nome NOVO é obra desta migration: é ela que o filtro da
                // linha de base tem de ver (revisão do #391 — um rename que o
                // Publish deixasse para trás passaria verde). Vale para a
                // tabela e para tudo o que passa a ser endereçado por ela.
                tables.delete(x.from); tables.set(x.to, f.filename);
                for (const [k] of [...columns]) if (k.startsWith(x.from + ".")) { columns.delete(k); columns.set(x.to + k.slice(x.from.length), f.filename); }
                for (const [k, v] of [...constraints]) if (k.startsWith(x.from + ".")) { constraints.delete(k); constraints.set(x.to + k.slice(x.from.length), { ...v, migration: f.filename }); }
                for (const v of indexes.values()) if (v.table === x.from) { v.table = x.to; v.migration = f.filename; }
            } else if (x.kind === "column" && x.op === "add") columns.set(`${x.table}.${x.column}`, f.filename);
            else if (x.kind === "column" && x.op === "drop") {
                columns.delete(`${x.table}.${x.column}`);
                // O Postgres derruba junto índice e constraint que dependam da
                // coluna (casos 073 e 068). Critério por menção do nome na
                // definição — pode remover a mais, nunca cria expectativa falsa.
                const menciona = new RegExp("\\b" + x.column + "\\b", "i");
                for (const [k, v] of [...indexes]) if (v.table === x.table && menciona.test(v.def || "")) indexes.delete(k);
                for (const [k, v] of [...constraints]) if (k.startsWith(x.table + ".") && menciona.test(v.def || "")) constraints.delete(k);
            } else if (x.kind === "column" && x.op === "rename") {
                columns.delete(`${x.table}.${x.from}`); columns.set(`${x.table}.${x.to}`, f.filename);
            } else if (x.kind === "index" && x.op === "add") indexes.set(x.name, { table: x.table, migration: f.filename, def: x.def });
            else if (x.kind === "index" && x.op === "drop") indexes.delete(x.name);
            else if (x.kind === "constraint" && x.op === "add") constraints.set(`${x.table}.${x.name}`, { migration: f.filename, def: x.def });
            else if (x.kind === "constraint" && x.op === "drop") constraints.delete(`${x.table}.${x.name}`);
        }
    }
    return { tables, columns, indexes, constraints, withoutFacts: semFatos, unnamed };
}

// Só o que foi introduzido DEPOIS da linha de base. O replay continua sendo
// completo (para DROPs e RENAMEs valerem); o filtro é só na saída.
export function afterBaseline(expected, baseline = SCHEMA_BASELINE) {
    const depois = (mig) => String(mig).slice(0, 3) > baseline;
    return {
        tables: new Map([...expected.tables].filter(([, mig]) => depois(mig))),
        columns: new Map([...expected.columns].filter(([, mig]) => depois(mig))),
        indexes: new Map([...expected.indexes].filter(([, v]) => depois(v.migration))),
        constraints: new Map([...expected.constraints].filter(([, v]) => depois(v.migration))),
        withoutFacts: expected.withoutFacts.filter(depois),
        unnamed: expected.unnamed.filter(u => depois(u.migration)),
        baseline,
    };
}

export function readMigrationFiles(dir) {
    return fs.readdirSync(dir)
        .filter(f => /^\d{3}_.+\.sql$/i.test(f))
        .sort()
        .map(filename => ({ version: filename.slice(0, 3), filename, sql: fs.readFileSync(path.join(dir, filename), "utf8") }));
}

// Compara o esperado com o catálogo vivo. `catalog`: { tables:Set, columns:Set
// ("table.column"), indexes:Set, constraints:Set ("table.name") }. Devolve os
// objetos ausentes, cada um com a migration que o introduziu.
export function diffExpected(expected, catalog) {
    const missing = [];
    const tabelasAcusadas = new Set();
    for (const [t, mig] of expected.tables) if (!catalog.tables.has(t)) { missing.push({ kind: "table", name: t, migration: mig }); tabelasAcusadas.add(t); }
    // Tabela ausente esconde os filhos SÓ se ela própria foi acusada. Uma
    // tabela anterior à linha de base (não esperada) que sumiu é acusada aqui,
    // uma vez, pela migration do primeiro filho — senão a ausência do objeto
    // novo passaria verde (revisão do #391).
    const semTabela = (t, mig) => {
        if (catalog.tables.has(t)) return false;
        if (!tabelasAcusadas.has(t)) { missing.push({ kind: "table", name: t, migration: mig, note: "tabela anterior à linha de base ausente" }); tabelasAcusadas.add(t); }
        return true;
    };
    for (const [c, mig] of expected.columns) {
        const [t] = c.split(".");
        if (semTabela(t, mig)) continue;
        if (!catalog.columns.has(c)) missing.push({ kind: "column", name: c, migration: mig });
    }
    for (const [i, v] of expected.indexes) {
        if (semTabela(v.table, v.migration)) continue;
        if (!catalog.indexes.has(i)) missing.push({ kind: "index", name: i, migration: v.migration });
    }
    for (const [c, v] of expected.constraints) {
        const [t] = c.split(".");
        if (semTabela(t, v.migration)) continue;
        if (!catalog.constraints.has(c)) missing.push({ kind: "constraint", name: c, migration: v.migration });
    }
    return missing;
}

// As quatro consultas ao catálogo, prontas para qualquer executor de SQL
// somente-leitura.
export const CATALOG_SQL = {
    tables: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    columns: `SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = 'public'`,
    indexes: `SELECT indexname AS name, tablename AS "table" FROM pg_indexes WHERE schemaname = 'public'`,
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
        if (k === "indexes") cat.indexTables = new Map(r.rows.filter(x => x.table).map(x => [String(x.name).toLowerCase(), String(x.table).toLowerCase()]));
    }
    return cat;
}

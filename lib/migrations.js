// Migrations runner.
//
// Convenção: arquivos em `migrations/` nomeados `NNN_descricao.sql` (zero-pad
// 3 dígitos). Aplicados em ordem alfabética = ordem numérica. Cada arquivo
// roda em uma transação; falha = rollback + boot abortado.
//
// Idempotência: cada migration roda no máximo uma vez por banco. A tabela
// `schema_migrations` registra o que já foi aplicado.
//
// REGRAS DURAS (ver CLAUDE.md "Schema do banco"):
// - Nunca editar uma migration depois de qualquer deploy.
// - Para corrigir bug em migration aplicada: criar NNN+1 corretiva.
// - Para corrigir bug em migration que falhou (não registrada): editar OK,
//   já que não foi aplicada em lugar nenhum ainda.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../auth.js";
import log from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    filename   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// Guard: só o CLI (scripts/migrate.mjs) seta MIGRATIONS_CLI=1. Qualquer outro
// caller (ex.: alguém um dia plugando runMigrations no boot do server.js de
// novo) bate aqui e falha alto, antes de qualquer DDL. Ver CLAUDE.md "Schema
// do banco" — boot NÃO roda migrations; em prod o schema vem do Publish do
// Replit.
function assertCliContext() {
    if (process.env.MIGRATIONS_CLI !== "1") {
        throw new Error(
            "runMigrations só pode ser chamado pelo CLI (scripts/migrate.mjs). " +
            "Boot do servidor NÃO roda migrations — em prod o schema vem do Publish do Replit. " +
            "Ver CLAUDE.md seção 'Schema do banco'."
        );
    }
}

function listMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`migrations/ não encontrado em ${MIGRATIONS_DIR}`);
    }
    const entries = fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{3}_.+\.sql$/i.test(f))
        .sort();
    return entries.map((filename) => ({
        version: filename.slice(0, 3),
        filename,
        fullPath: path.join(MIGRATIONS_DIR, filename),
    }));
}

async function listAppliedVersions(client) {
    const r = await client.query("SELECT version FROM schema_migrations");
    return new Set(r.rows.map((row) => row.version));
}

export async function runMigrations() {
    assertCliContext();
    await pool.query(ENSURE_TABLE_SQL);

    const all = listMigrationFiles();
    if (all.length === 0) {
        log.warn("MIGRATIONS", "nenhum arquivo encontrado em migrations/");
        return { applied: [], skipped: [] };
    }

    const client = await pool.connect();
    let applied = [];
    let skipped = [];
    try {
        const appliedSet = await listAppliedVersions(client);
        for (const m of all) {
            if (appliedSet.has(m.version)) {
                skipped.push(m.filename);
                continue;
            }
            const sql = fs.readFileSync(m.fullPath, "utf8");
            const started = Date.now();
            try {
                await client.query("BEGIN");
                await client.query(sql);
                await client.query(
                    "INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)",
                    [m.version, m.filename]
                );
                await client.query("COMMIT");
                const dur = Date.now() - started;
                log.info("MIGRATIONS", `✓ ${m.filename} aplicada (${dur} ms)`);
                applied.push(m.filename);
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {});
                log.error("MIGRATIONS", `✗ ${m.filename} falhou: ${err.message}`);
                throw err;
            }
        }
    } finally {
        client.release();
    }

    if (applied.length === 0) {
        log.info("MIGRATIONS", `db está em dia (${skipped.length} migrations já aplicadas)`);
    } else {
        log.info("MIGRATIONS", `${applied.length} aplicadas, ${skipped.length} já em dia`);
    }
    return { applied, skipped };
}

export async function listMigrationStatus() {
    assertCliContext();
    await pool.query(ENSURE_TABLE_SQL);
    const all = listMigrationFiles();
    const client = await pool.connect();
    try {
        const appliedSet = await listAppliedVersions(client);
        return all.map((m) => ({
            version: m.version,
            filename: m.filename,
            applied: appliedSet.has(m.version),
        }));
    } finally {
        client.release();
    }
}

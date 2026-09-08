// Tokens de acesso programático (migration 053; alcance na 082).
//
// Um token serve a UM alcance (`scope`): `analytics` (endpoint de análise,
// somente-leitura) ou `health` (verificação de saúde). A validade padrão vem
// da tabela de alcances — 30 dias para análise, 365 para saúde. O banco guarda
// só o hash; o texto puro aparece uma vez, na geração.
import { pool } from "../../auth.js";

export async function listTokenScopes() {
    const { rows } = await pool.query(`SELECT key, name, ttl_days FROM analytics_token_scopes ORDER BY key`);
    return rows;
}

export async function createAnalyticsToken({ tokenHash, tokenPrefix, label, createdBy, scope = "analytics" }) {
    // A FK garante que o alcance existe; a validade é a do alcance.
    const { rows } = await pool.query(
        `INSERT INTO analytics_tokens (token_hash, token_prefix, label, created_by, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5,
                 now() + (SELECT ttl_days FROM analytics_token_scopes WHERE key = $5) * interval '1 day')
         RETURNING id, token_prefix, label, created_by, scope, created_at, expires_at`,
        [tokenHash, tokenPrefix, label || null, createdBy || null, scope]
    );
    return rows[0];
}

export async function listAnalyticsTokens() {
    const { rows } = await pool.query(
        `SELECT t.id, t.token_prefix, t.label, t.created_by, t.scope, s.name AS scope_name,
                t.created_at, t.expires_at, t.revoked_at,
                (t.revoked_at IS NULL AND t.expires_at > now()) AS active
         FROM analytics_tokens t JOIN analytics_token_scopes s ON s.key = t.scope
         ORDER BY t.created_at DESC`
    );
    return rows;
}

export async function revokeAnalyticsToken(id) {
    const { rowCount } = await pool.query(
        `UPDATE analytics_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [id]
    );
    return rowCount > 0;
}

// Autenticação: acha um token VIVO (não revogado, não expirado) pelo hash.
// Devolve o alcance — quem chama decide se ele serve ao uso. `q` opcional: o
// health check (#375) valida pelo SEU pool, com prazo de conexão e
// statement_timeout — a validação não pode ficar pendurada no pool do app
// quando é o banco que está sendo diagnosticado.
export async function findValidAnalyticsToken(tokenHash, q = (sql, values) => pool.query(sql, values)) {
    const { rows } = await q(
        `SELECT id, token_prefix, scope FROM analytics_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [tokenHash]
    );
    return rows[0] || null;
}

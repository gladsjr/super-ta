// Tokens do endpoint de análise (migration 053). Gerados pelo admin, guardados
// como hash (sha256). Validade fixa de 30 dias, calculada no banco (now() +
// interval) para a fonte da verdade ser o relógio do Postgres.

import { pool } from "../../auth.js";

const TTL = "30 days";

// Cria um token. Recebe o HASH e o prefixo (o texto puro nunca chega ao banco).
export async function createAnalyticsToken({ tokenHash, tokenPrefix, label, createdBy }) {
    const { rows } = await pool.query(
        `INSERT INTO analytics_tokens (token_hash, token_prefix, label, created_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '${TTL}')
         RETURNING id, token_prefix, label, created_by, created_at, expires_at`,
        [tokenHash, tokenPrefix, label || null, createdBy || null]
    );
    return rows[0];
}

export async function listAnalyticsTokens() {
    const { rows } = await pool.query(
        `SELECT id, token_prefix, label, created_by, created_at, expires_at, revoked_at,
                (revoked_at IS NULL AND expires_at > now()) AS active
         FROM analytics_tokens ORDER BY created_at DESC`
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
export async function findValidAnalyticsToken(tokenHash) {
    const { rows } = await pool.query(
        `SELECT id, token_prefix FROM analytics_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [tokenHash]
    );
    return rows[0] || null;
}

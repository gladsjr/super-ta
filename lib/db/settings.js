// Configuração operacional mutável em runtime (tabela app_settings, migration
// 074). Chave-valor JSONB — hoje só 'proctor_concurrency' (tela de Operações).
import { pool } from "../../auth.js";

export async function getSetting(key) {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
    return r.rows[0] ? r.rows[0].value : null;
}

export async function setSetting(key, value) {
    await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)]
    );
    return value;
}

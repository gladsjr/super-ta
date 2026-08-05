// Pessoa — o agregador do humano (migration 068). Camada fina por cima da
// conta-de-e-mail (`users`): junta os e-mails do mesmo humano por identificador
// civil (CPF hoje) e é a ponte para funcionalidades futuras. Ver
// docs/auth-multitenant-plan.md.
//
// O CPF é capturado na ACEITAÇÃO do vínculo (ativação de convite / criação da
// própria unidade), nunca na criação pelo admin — o admin pode não saber o CPF.

import { pool } from "../auth.js";
import { normalizeCpf, isValidCpf } from "./cpf.js";

async function civilTypeId(client, key) {
    const r = await client.query(`SELECT id FROM civil_id_types WHERE key = $1`, [key]);
    if (r.rowCount === 0) throw Object.assign(new Error(`unknown_civil_id_type: ${key}`), { status: 500 });
    return r.rows[0].id;
}

// find-or-create da pessoa por (tipo civil, valor). Piloto: tipo sempre 'cpf'.
// Valida o CPF; grava normalizado (11 dígitos). Atualiza display_name se vier e a
// pessoa ainda não tiver. Usa um client de transação se fornecido.
export async function findOrCreatePersonByCpf({ cpf, displayName = null }, client = pool) {
    if (!isValidCpf(cpf)) throw Object.assign(new Error("invalid_cpf"), { status: 400 });
    const value = normalizeCpf(cpf);
    const typeId = await civilTypeId(client, "cpf");

    const found = await client.query(
        `SELECT * FROM persons WHERE civil_id_type_id = $1 AND civil_id_value = $2 LIMIT 1`,
        [typeId, value]
    );
    if (found.rowCount > 0) {
        const p = found.rows[0];
        if (displayName && !p.display_name) {
            await client.query(`UPDATE persons SET display_name = $1, updated_at = now() WHERE id = $2`, [displayName, p.id]);
        }
        return p;
    }
    const ins = await client.query(
        `INSERT INTO persons (civil_id_type_id, civil_id_value, display_name)
         VALUES ($1, $2, $3) RETURNING *`,
        [typeId, value, displayName]
    );
    return ins.rows[0];
}

// Liga uma conta-de-e-mail (user) a uma pessoa. Idempotente.
export async function linkUserToPerson(userId, personId, client = pool) {
    await client.query(`UPDATE users SET person_id = $1 WHERE id = $2`, [personId, userId]);
}

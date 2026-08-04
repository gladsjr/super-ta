// Árvore de unidades (genérica e recursiva). CTEs de ancestral/descendente +
// CRUD básico. Ver replit.md / docs/access-model.md.
//
// Aditivo e opcional: trabalhos legados têm unit_id NULL e ignoram tudo isto.

import { pool } from "../auth.js";

// IDs de unitId até a raiz, INCLUINDO a própria unitId. Ordenado da folha (depth
// 0) para a raiz. Usado pela resolução de papéis (herança pra baixo lida daqui
// de baixo pra cima) e pelo teto de US$ (ancestral vinculante mais próximo).
export async function ancestorUnitIds(unitId) {
    if (unitId == null) return [];
    const r = await pool.query(
        `WITH RECURSIVE up AS (
             SELECT id, parent_id, 0 AS depth FROM units WHERE id = $1
             UNION ALL
             SELECT u.id, u.parent_id, up.depth + 1
               FROM units u JOIN up ON u.id = up.parent_id
         )
         SELECT id FROM up ORDER BY depth ASC`,
        [unitId]
    );
    return r.rows.map((x) => x.id);
}

// IDs da sub-árvore de unitId, INCLUINDO a própria unitId.
export async function descendantUnitIds(unitId) {
    if (unitId == null) return [];
    const r = await pool.query(
        `WITH RECURSIVE down AS (
             SELECT id FROM units WHERE id = $1
             UNION ALL
             SELECT u.id FROM units u JOIN down ON u.parent_id = down.id
         )
         SELECT id FROM down`,
        [unitId]
    );
    return r.rows.map((x) => x.id);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listUnits() {
    const r = await pool.query(
        `SELECT id, parent_id, name, label,
                budget_usd::float8 AS budget_usd,
                is_class, is_active, source, created_at
           FROM units
          ORDER BY COALESCE(parent_id, 0) ASC, name ASC`
    );
    return r.rows;
}

export async function getUnit(id) {
    const r = await pool.query(
        `SELECT id, parent_id, name, label,
                budget_usd::float8 AS budget_usd,
                is_class, is_active, source, created_at
           FROM units WHERE id = $1`,
        [id]
    );
    return r.rows[0] || null;
}

// isClass marca a unidade como TURMA (contexto de trabalho): só turma pode
// receber trabalhos, e turma não pode ter filhos. O teto (budgetUsd) na criação
// NÃO passa por aqui — reserva contra o saldo do pai é setUnitBudgetReserved
// (lib/billing.js); o caller cria a unidade e reserva em seguida.
export async function createUnit({ name, parentId = null, label = null, isClass = false, source = "manual" }) {
    const nm = String(name ?? "").trim();
    if (!nm) throw Object.assign(new Error("name_required"), { status: 400 });
    if (parentId != null) {
        const parent = await getUnit(parentId);
        if (!parent) throw Object.assign(new Error("parent_not_found"), { status: 404 });
        if (parent.is_class) throw Object.assign(new Error("class_cannot_have_children"), { status: 400 });
    }
    const r = await pool.query(
        `INSERT INTO units (parent_id, name, label, is_class, source)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, parent_id, name, label, budget_usd::float8 AS budget_usd, is_class, is_active, source, created_at`,
        [parentId, nm, label ? String(label).trim() : null, !!isClass, source]
    );
    return r.rows[0];
}

// Liga/desliga o flag de turma com as validações estruturais: ligar exige nó
// sem filhos; desligar exige nó sem trabalhos vinculados (trabalho é da turma).
export async function setUnitClass(id, isClass) {
    if (isClass) {
        const kids = await pool.query(`SELECT 1 FROM units WHERE parent_id = $1 LIMIT 1`, [id]);
        if (kids.rowCount > 0) throw Object.assign(new Error("has_children"), { status: 409 });
    } else {
        const works = await pool.query(`SELECT 1 FROM works WHERE unit_id = $1 LIMIT 1`, [id]);
        if (works.rowCount > 0) throw Object.assign(new Error("has_works"), { status: 409 });
    }
    const r = await pool.query(
        `UPDATE units SET is_class = $1, updated_at = now() WHERE id = $2 RETURNING id, is_class`,
        [!!isClass, id]
    );
    if (r.rowCount === 0) throw Object.assign(new Error("not_found"), { status: 404 });
    return r.rows[0];
}

export async function renameUnit(id, name, label) {
    const nm = String(name ?? "").trim();
    if (!nm) throw Object.assign(new Error("name_required"), { status: 400 });
    const r = await pool.query(
        `UPDATE units SET name = $1, label = $2, updated_at = now() WHERE id = $3
         RETURNING id, name, label`,
        [nm, label ? String(label).trim() : null, id]
    );
    if (r.rowCount === 0) throw Object.assign(new Error("not_found"), { status: 404 });
    return r.rows[0];
}

export async function setUnitActive(id, isActive) {
    const r = await pool.query(
        `UPDATE units SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING id, is_active`,
        [!!isActive, id]
    );
    if (r.rowCount === 0) throw Object.assign(new Error("not_found"), { status: 404 });
    return r.rows[0];
}

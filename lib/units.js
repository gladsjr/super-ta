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
// Rótulos (tipo da unidade) — tabela-lookup unit_labels (migration 070).
// 'turma' é o tipo ESPECIAL: dispara is_class. Fonte da verdade das linhas é
// UNIT_LABELS, sincronizada no boot por seedUnitLabels() (auth.js).
// ---------------------------------------------------------------------------
export const UNIT_LABELS = [
    { key: "turma", name: "Turma" }, // especial: dispara is_class (não tem filhos, recebe trabalho)
    { key: "instituicao", name: "Instituição" },
    { key: "universidade", name: "Universidade" },
    { key: "faculdade", name: "Faculdade" },
    { key: "escola", name: "Escola" },
    { key: "campus", name: "Campus" },
    { key: "departamento", name: "Departamento" },
    { key: "instituto", name: "Instituto" },
    { key: "curso", name: "Curso" },
];
export const TURMA_KEY = "turma";

export async function listUnitLabels() {
    const r = await pool.query(`SELECT id, key, name FROM unit_labels`);
    const order = new Map(UNIT_LABELS.map((l, i) => [l.key, i]));
    return r.rows.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

async function labelKeyOf(labelId) {
    if (labelId == null) return null;
    const r = await pool.query(`SELECT key FROM unit_labels WHERE id = $1`, [labelId]);
    return r.rows[0]?.key ?? null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const UNIT_COLS = `u.id, u.parent_id, u.name, u.label_id,
                l.key AS label_key, l.name AS label_name,
                u.budget_usd::float8 AS budget_usd,
                u.is_class, u.is_active, u.source, u.created_at`;

export async function listUnits() {
    const r = await pool.query(
        `SELECT ${UNIT_COLS} FROM units u LEFT JOIN unit_labels l ON l.id = u.label_id
          ORDER BY COALESCE(u.parent_id, 0) ASC, u.name ASC`
    );
    return r.rows;
}

export async function getUnit(id) {
    const r = await pool.query(
        `SELECT ${UNIT_COLS} FROM units u LEFT JOIN unit_labels l ON l.id = u.label_id WHERE u.id = $1`,
        [id]
    );
    return r.rows[0] || null;
}

// O TIPO (label) define se é turma: labelId cujo key = 'turma' liga is_class
// (contexto de trabalho: recebe trabalho, não tem filhos). is_class é derivado —
// mantido aqui, lido pelo resto do código. O teto na criação NÃO passa por aqui
// (é setUnitBudgetReserved).
export async function createUnit({ name, parentId = null, labelId = null, source = "manual" }) {
    const nm = String(name ?? "").trim();
    if (!nm) throw Object.assign(new Error("name_required"), { status: 400 });
    if (parentId != null) {
        const parent = await getUnit(parentId);
        if (!parent) throw Object.assign(new Error("parent_not_found"), { status: 404 });
        if (parent.is_class) throw Object.assign(new Error("class_cannot_have_children"), { status: 400 });
    }
    const isClass = (await labelKeyOf(labelId)) === TURMA_KEY;
    const r = await pool.query(
        `INSERT INTO units (parent_id, name, label_id, is_class, source)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [parentId, nm, labelId, isClass, source]
    );
    return getUnit(r.rows[0].id);
}

// Define o TIPO (label) da unidade — e, com ele, is_class (derivado de turma).
// Funde a antiga troca de rótulo + marcar/desmarcar turma, com as travas: virar
// turma exige nó sem filhos; deixar de ser turma exige nó sem trabalhos.
export async function setUnitLabel(id, labelId) {
    const cur = await getUnit(id);
    if (!cur) throw Object.assign(new Error("not_found"), { status: 404 });
    const newIsClass = (await labelKeyOf(labelId)) === TURMA_KEY;
    if (newIsClass && !cur.is_class) {
        const kids = await pool.query(`SELECT 1 FROM units WHERE parent_id = $1 LIMIT 1`, [id]);
        if (kids.rowCount > 0) throw Object.assign(new Error("has_children"), { status: 409 });
    }
    if (!newIsClass && cur.is_class) {
        const works = await pool.query(`SELECT 1 FROM works WHERE unit_id = $1 LIMIT 1`, [id]);
        if (works.rowCount > 0) throw Object.assign(new Error("has_works"), { status: 409 });
    }
    await pool.query(
        `UPDATE units SET label_id = $1, is_class = $2, updated_at = now() WHERE id = $3`,
        [labelId, newIsClass, id]
    );
    return getUnit(id);
}

export async function renameUnit(id, name) {
    const nm = String(name ?? "").trim();
    if (!nm) throw Object.assign(new Error("name_required"), { status: 400 });
    const r = await pool.query(
        `UPDATE units SET name = $1, updated_at = now() WHERE id = $2 RETURNING id`,
        [nm, id]
    );
    if (r.rowCount === 0) throw Object.assign(new Error("not_found"), { status: 404 });
    return getUnit(id);
}

export async function setUnitActive(id, isActive) {
    const r = await pool.query(
        `UPDATE units SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING id, is_active`,
        [!!isActive, id]
    );
    if (r.rowCount === 0) throw Object.assign(new Error("not_found"), { status: 404 });
    return r.rows[0];
}

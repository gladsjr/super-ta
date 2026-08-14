// Controle de acessos tenant-aware. Papel é POR UNIDADE (memberships) e vive
// na tabela `roles` (id interno + key estável + nome de exibição — padrão do
// projeto para enumerações). Resolvido por request — NUNCA cacheado na sessão
// (revogar tem efeito imediato).
//
// Herança (decisão de 04/08/2026 — "disponibilidade não é acesso"):
// - SÓ administração herda para baixo: admin_unidade numa unidade vale nela e
//   em toda a sub-árvore (delegação: criar unidades filhas, atribuir pessoas).
// - professor e aluno são LOCAIS ao nó. Vínculo num ancestral torna a pessoa
//   DISPONÍVEL para escolha nas descendentes (ver listAvailablePeople), nunca
//   membro automático: inscrição de aluno e atribuição de professor são
//   vínculos explícitos na unidade (tipicamente a turma).
//
// Coexistência com token: este módulo só governa rotas de SESSÃO. Os gates de
// token (requireWorkToken/requireSubmissionToken em lib/middleware.js) seguem
// intactos — token continua sendo capacidade plena.

import { pool } from "../auth.js";
import { ancestorUnitIds } from "./units.js";

// Fonte da verdade das linhas de `roles` — sincronizada no boot por seedRoles()
// (auth.js). O código referencia papéis pela `key`; o banco, por role_id (FK).
export const ROLE_DEFS = [
    { key: "admin_global", name: "Administrador global" },
    { key: "admin_unidade", name: "Administrador" },
    { key: "professor", name: "Professor" },
    { key: "aluno", name: "Aluno" },
];
export const ROLE_KEYS = ROLE_DEFS.map((r) => r.key);

// Papéis que herdam para a sub-árvore. Comportamento, não dado: fica no código.
const INHERITING_ROLES = ["admin_unidade"];

// Papéis EFETIVOS do usuário na unidade: qualquer papel NA própria unidade,
// papéis de administração em ancestrais (herança), e admin_global (unit_id
// NULL, vale em toda a árvore). Set<string> de keys.
export async function resolveEffectiveRoles(userId, unitId) {
    const roles = new Set();
    const g = await pool.query(
        `SELECT r.key FROM memberships m JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.unit_id IS NULL`,
        [userId]
    );
    for (const row of g.rows) roles.add(row.key);

    if (unitId != null) {
        const chain = await ancestorUnitIds(unitId); // [própria, mãe, avó, ...]
        if (chain.length) {
            const strictAncestors = chain.slice(1);
            const r = await pool.query(
                `SELECT DISTINCT r.key FROM memberships m JOIN roles r ON r.id = m.role_id
                  WHERE m.user_id = $1
                    AND (m.unit_id = $2
                         OR (m.unit_id = ANY($3::int[]) AND r.key = ANY($4::text[])))`,
                [userId, chain[0], strictAncestors, INHERITING_ROLES]
            );
            for (const row of r.rows) roles.add(row.key);
        }
    }
    return roles;
}

export async function isGlobalAdmin(userId) {
    const r = await pool.query(
        `SELECT 1 FROM memberships m JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.unit_id IS NULL AND r.key = 'admin_global' LIMIT 1`,
        [userId]
    );
    return r.rowCount > 0;
}

// Pode ADMINISTRAR a unidade alvo? admin_global (em tudo) OU admin_unidade num
// ancestral da unidade (inclusive ela mesma). É assim que a delegação desce a
// sub-árvore: admin do Depto X só age em X e descendentes, nunca num irmão.
export async function canAdminUnit(userId, targetUnitId) {
    if (await isGlobalAdmin(userId)) return true;
    const roles = await resolveEffectiveRoles(userId, targetUnitId);
    return roles.has("admin_unidade");
}

// Papéis para a UI (dropdowns). Direto da tabela — ordem de ROLE_DEFS.
export async function listRoles() {
    const r = await pool.query(`SELECT id, key, name FROM roles`);
    const order = new Map(ROLE_KEYS.map((k, i) => [k, i]));
    return r.rows.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

async function roleIdByKey(roleKey) {
    const r = await pool.query(`SELECT id FROM roles WHERE key = $1`, [roleKey]);
    if (r.rowCount === 0) throw Object.assign(new Error("invalid_role"), { status: 400 });
    return r.rows[0].id;
}

// Vínculos pessoa→papel de uma unidade (para a aba "Membros" do detalhe).
export async function listUnitMembers(unitId) {
    const r = await pool.query(
        `SELECT m.id, m.user_id, r.key AS role, r.name AS role_name, m.source, m.created_at,
                u.username, u.email, u.display_name
           FROM memberships m
           JOIN roles r ON r.id = m.role_id
           JOIN users u ON u.id = m.user_id
          WHERE m.unit_id = $1
          ORDER BY r.key ASC, u.username ASC`,
        [unitId]
    );
    return r.rows;
}

// DISPONIBILIDADE (não é acesso): candidatos a receber `roleKey` na unidade,
// vindos do ancestral MAIS PRÓXIMO que tiver gente nesse papel — se a mãe tem,
// só valem os da mãe; se está vazia, sobe para a avó, e assim por diante
// (decisão de 04/08/2026). Exclui quem já tem o papel na própria unidade.
// Retorna { source_unit_id, people } (source_unit_id null = ninguém disponível).
export async function listAvailablePeople(unitId, roleKey) {
    const chain = await ancestorUnitIds(unitId);
    const strictAncestors = chain.slice(1); // da mãe para a raiz
    if (!strictAncestors.length) return { source_unit_id: null, people: [] };
    const r = await pool.query(
        `SELECT m.unit_id, m.user_id, u.username, u.email, u.display_name
           FROM memberships m
           JOIN roles r ON r.id = m.role_id
           JOIN users u ON u.id = m.user_id
          WHERE m.unit_id = ANY($1::int[]) AND r.key = $2
          ORDER BY u.display_name NULLS LAST, u.username`,
        [strictAncestors, roleKey]
    );
    if (!r.rows.length) return { source_unit_id: null, people: [] };
    const byUnit = new Map();
    for (const row of r.rows) {
        if (!byUnit.has(row.unit_id)) byUnit.set(row.unit_id, []);
        byUnit.get(row.unit_id).push(row);
    }
    let sourceUnitId = null;
    for (const aid of strictAncestors) {
        if (byUnit.has(aid)) { sourceUnitId = aid; break; }
    }
    const already = await pool.query(
        `SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
          WHERE m.unit_id = $1 AND r.key = $2`,
        [unitId, roleKey]
    );
    const taken = new Set(already.rows.map((x) => x.user_id));
    const people = byUnit.get(sourceUnitId)
        .filter((p) => !taken.has(p.user_id))
        .map(({ user_id, username, email, display_name }) => ({ user_id, username, email, display_name }));
    return { source_unit_id: sourceUnitId, people };
}

// client opcional (default pool): permite participar de uma transação externa
// (ex.: createPersonWithInvite atômico, issue #159). roleIdByKey lê a tabela
// estática de papéis — pode seguir no pool mesmo dentro de transação.
export async function addMembership({ userId, unitId, role, source = "manual" }, client = pool) {
    const roleId = await roleIdByKey(role);
    if (role === "admin_global" && unitId != null) {
        throw Object.assign(new Error("admin_global_is_unitless"), { status: 400 });
    }
    if (role !== "admin_global" && unitId == null) {
        throw Object.assign(new Error("unit_required"), { status: 400 });
    }
    const r = await client.query(
        `INSERT INTO memberships (user_id, unit_id, role_id, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id, user_id, unit_id, role_id, source, created_at`,
        [userId, unitId, roleId, source]
    );
    if (!r.rows[0]) return null; // null = já existia
    return { ...r.rows[0], role };
}

export async function removeMembership(id) {
    const r = await pool.query(`DELETE FROM memberships WHERE id = $1 RETURNING id`, [id]);
    if (r.rowCount === 0) throw Object.assign(new Error("not_found"), { status: 404 });
    return r.rows[0];
}

// ---------------------------------------------------------------------------
// Middleware (rotas de sessão). unitParam: nome do :param ou campo do body.
// ---------------------------------------------------------------------------

function resolveUnitId(req, unitParam) {
    const raw = req.params?.[unitParam] ?? req.body?.unit_id ?? req.body?.[unitParam];
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
}

export function requireUnitRole(role, unitParam = "unitId") {
    return async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
        const unitId = resolveUnitId(req, unitParam);
        if (unitId == null) return res.status(400).json({ error: "unit required" });
        try {
            const roles = await resolveEffectiveRoles(req.session.user.id, unitId);
            if (roles.has("admin_global") || roles.has(role)) return next();
            return res.status(403).json({ error: "forbidden" });
        } catch (err) {
            console.error("requireUnitRole error:", err);
            return res.status(500).json({ error: "internal error" });
        }
    };
}

// Delegação-pra-baixo: só passa quem administra a unidade alvo (ela ou ancestral).
export function requireUnitAdmin(unitParam = "unitId") {
    return async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
        const unitId = resolveUnitId(req, unitParam);
        if (unitId == null) return res.status(400).json({ error: "unit required" });
        try {
            if (await canAdminUnit(req.session.user.id, unitId)) return next();
            return res.status(403).json({ error: "forbidden" });
        } catch (err) {
            console.error("requireUnitAdmin error:", err);
            return res.status(500).json({ error: "internal error" });
        }
    };
}

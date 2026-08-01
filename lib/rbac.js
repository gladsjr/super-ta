// Controle de acessos tenant-aware. Papel é POR UNIDADE (memberships) e herda
// PARA BAIXO (um papel numa unidade vale nela e em toda a sub-árvore). Resolvido
// por request — NUNCA cacheado na sessão (revogar tem efeito imediato).
//
// Coexistência com token: este módulo só governa rotas de SESSÃO. Os gates de
// token (requireWorkToken/requireSubmissionToken em lib/middleware.js) seguem
// intactos — token continua sendo capacidade plena.

import { pool } from "../auth.js";
import { ancestorUnitIds } from "./units.js";

export const ROLES = ["admin_global", "admin_unidade", "professor", "funcionario", "aluno"];

// Papéis EFETIVOS do usuário na unidade: papéis na própria unidade OU em qualquer
// ancestral, mais admin_global (unit_id NULL, vale em toda a árvore). Set<string>.
export async function resolveEffectiveRoles(userId, unitId) {
    const roles = new Set();
    const g = await pool.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND unit_id IS NULL`,
        [userId]
    );
    for (const row of g.rows) roles.add(row.role);

    if (unitId != null) {
        const chain = await ancestorUnitIds(unitId); // inclui a própria unidade
        if (chain.length) {
            const r = await pool.query(
                `SELECT DISTINCT role FROM memberships
                  WHERE user_id = $1 AND unit_id = ANY($2::int[])`,
                [userId, chain]
            );
            for (const row of r.rows) roles.add(row.role);
        }
    }
    return roles;
}

export async function isGlobalAdmin(userId) {
    const r = await pool.query(
        `SELECT 1 FROM memberships
          WHERE user_id = $1 AND unit_id IS NULL AND role = 'admin_global' LIMIT 1`,
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

// Vínculos pessoa→papel de uma unidade (para a aba "Membros" do detalhe).
export async function listUnitMembers(unitId) {
    const r = await pool.query(
        `SELECT m.id, m.user_id, m.role, m.source, m.created_at,
                u.username, u.email, u.display_name
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.unit_id = $1
          ORDER BY m.role ASC, u.username ASC`,
        [unitId]
    );
    return r.rows;
}

export async function addMembership({ userId, unitId, role, source = "manual" }) {
    if (!ROLES.includes(role)) throw Object.assign(new Error("invalid_role"), { status: 400 });
    if (role === "admin_global" && unitId != null) {
        throw Object.assign(new Error("admin_global_is_unitless"), { status: 400 });
    }
    if (role !== "admin_global" && unitId == null) {
        throw Object.assign(new Error("unit_required"), { status: 400 });
    }
    const r = await pool.query(
        `INSERT INTO memberships (user_id, unit_id, role, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id, user_id, unit_id, role, source, created_at`,
        [userId, unitId, role, source]
    );
    return r.rows[0] || null; // null = já existia
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

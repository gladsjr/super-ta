// Rotas da camada institucional (auth via sessão). Unidades (árvore), papéis
// (memberships), orçamento US$ por unidade (Gate A) e pacotes (Gate B:
// alocação/cascata + leitura de contadores). Ver docs/access-model.md.
//
// Coexistência: NÃO toca nos gates de token. Tudo aqui é aditivo e por sessão.
// Autorização em camadas:
//  - requireAdmin: precisa estar logado.
//  - canAdminUnit(user, unit): admin_global OU admin_unidade num ancestral →
//    é assim que a delegação desce a sub-árvore (nunca para um irmão).

import express from "express";
import { requireAdmin } from "../lib/middleware.js";
import { getUserByLogin } from "../auth.js";
import {
    listUnits, getUnit, createUnit, renameUnit, setUnitActive, setUnitClass,
} from "../lib/units.js";
import {
    isGlobalAdmin, canAdminUnit, resolveEffectiveRoles,
    listUnitMembers, addMembership, removeMembership, listRoles, listAvailablePeople,
} from "../lib/rbac.js";
import { getUnitBalance, setUnitBudgetReserved } from "../lib/billing.js";
import {
    allocateRoot, allocateToChild, returnToParent, listUnitEntitlements,
    unitEntitlementRollup, listPackageSpecs,
} from "../lib/packages.js";
import { pool } from "../auth.js";
import {
    createPersonWithInvite, issueInvite, cancelInvite, listUnitInvites,
    buildInviteEmailsText,
} from "../lib/invites.js";
import log from "../lib/logger.js";

const router = express.Router();
const json = express.json({ limit: "64kb" });

function uid(req) { return req.session.user.id; }
function httpErr(res, err, fallback = "internal error") {
    const status = err?.status || 500;
    if (status >= 500) log.error("UNITS", `${err.message}`);
    return res.status(status).json({ error: err?.message || fallback });
}

// Guard: quem pode ver o detalhe de uma unidade (algum papel efetivo nela ou
// admin global). Evita vazar árvore alheia a qualquer usuário logado.
async function canViewUnit(userId, unitId) {
    if (await isGlobalAdmin(userId)) return true;
    const roles = await resolveEffectiveRoles(userId, unitId);
    return roles.size > 0;
}

// ---------------------------------------------------------------------------
// Unidades (árvore)
// ---------------------------------------------------------------------------

// Lista plana da árvore (o frontend monta a hierarquia por parent_id).
router.get("/admin/units", requireAdmin, async (_req, res) => {
    try {
        res.json({ units: await listUnits() });
    } catch (err) { return httpErr(res, err); }
});

// Cria unidade. Raiz (sem parent) exige admin_global; filha exige admin na unidade-pai.
router.post("/admin/units", requireAdmin, json, async (req, res) => {
    const parentId = req.body?.parent_id ?? null;
    try {
        if (parentId == null) {
            if (!(await isGlobalAdmin(uid(req)))) return res.status(403).json({ error: "forbidden" });
        } else {
            if (!(await canAdminUnit(uid(req), Number(parentId)))) return res.status(403).json({ error: "forbidden" });
        }
        const unit = await createUnit({
            name: req.body?.name,
            parentId: parentId == null ? null : Number(parentId),
            label: req.body?.label ?? null,
            isClass: req.body?.is_class === true,
        });
        // Teto na criação = reserva contra o saldo do pai (Gate A). Se não
        // couber, desfaz a criação — sem unidade-fantasma sem teto.
        if (req.body?.budget_usd != null && req.body.budget_usd !== "") {
            try {
                await setUnitBudgetReserved(unit.id, Number(req.body.budget_usd));
                unit.budget_usd = Number(req.body.budget_usd);
            } catch (err) {
                await pool.query(`DELETE FROM units WHERE id = $1`, [unit.id]).catch(() => {});
                throw err;
            }
        }
        log.info("UNITS", `unit created id=${unit.id} name="${unit.name}" parent=${parentId ?? "root"} class=${unit.is_class} by=${req.session.user.username}`);
        res.json({ unit });
    } catch (err) { return httpErr(res, err); }
});

router.patch("/admin/units/:unitId", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        if (typeof req.body?.name === "string") {
            const u = await renameUnit(unitId, req.body.name, req.body?.label ?? null);
            return res.json({ unit: u });
        }
        if (typeof req.body?.is_active === "boolean") {
            const u = await setUnitActive(unitId, req.body.is_active);
            return res.json({ unit: u });
        }
        if (typeof req.body?.is_class === "boolean") {
            const u = await setUnitClass(unitId, req.body.is_class);
            return res.json({ unit: u });
        }
        return res.status(400).json({ error: "nothing to update" });
    } catch (err) { return httpErr(res, err); }
});

// Teto de US$ desta unidade (Gate A — RESERVA contra o saldo do pai; reduzir
// devolve; null remove o teto e a unidade volta a consumir do ancestral).
// A permissão é no PAI (é o saldo dele que a reserva mexe); para unidade raiz,
// admin da própria.
router.put("/admin/units/:unitId/budget", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    const raw = req.body?.budget_usd;
    try {
        const unit = await getUnit(unitId);
        if (!unit) return res.status(404).json({ error: "unit not found" });
        const permUnit = unit.parent_id ?? unitId;
        if (!(await canAdminUnit(uid(req), permUnit))) return res.status(403).json({ error: "forbidden" });
        const budget = raw === null || raw === "" || raw === undefined ? null : Number(raw);
        const u = await setUnitBudgetReserved(unitId, budget);
        res.json({ unit: u });
    } catch (err) { return httpErr(res, err); }
});

// Saldo/rollup em US$ (teto próprio vs gasto consolidado da sub-árvore).
router.get("/admin/units/:unitId/budget", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canViewUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const balance = await getUnitBalance(unitId);
        if (!balance) return res.status(404).json({ error: "unit not found" });
        res.json({ balance });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Membros & papéis (RBAC)
// ---------------------------------------------------------------------------

router.get("/admin/units/:unitId/members", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canViewUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        res.json({ members: await listUnitMembers(unitId), roles: await listRoles() });
    } catch (err) { return httpErr(res, err); }
});

// DISPONIBILIDADE (não é acesso): candidatos ao papel `role` nesta unidade,
// vindos do ancestral mais próximo que tiver gente nesse papel (mãe esconde
// avó). Serve o fluxo de inscrição de aluno / atribuição de professor.
router.get("/admin/units/:unitId/available-people", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const role = String(req.query.role || "aluno");
        res.json(await listAvailablePeople(unitId, role));
    } catch (err) { return httpErr(res, err); }
});

// Vincula papel a uma pessoa nesta unidade. Aceita user_id OU login (email/username).
router.post("/admin/units/:unitId/members", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        let userId = Number(req.body?.user_id);
        if (!Number.isInteger(userId)) {
            const u = await getUserByLogin(req.body?.login);
            if (!u) return res.status(404).json({ error: "user_not_found" });
            userId = u.id;
        }
        const m = await addMembership({ userId, unitId, role: req.body?.role });
        if (!m) return res.status(409).json({ error: "membership_exists" });
        log.info("UNITS", `membership added user=${userId} unit=${unitId} role=${req.body?.role} by=${req.session.user.username}`);
        res.json({ membership: m });
    } catch (err) { return httpErr(res, err); }
});

router.delete("/admin/units/:unitId/members/:membershipId", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        await removeMembership(Number(req.params.membershipId));
        res.json({ ok: true });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Pessoas & convites — o cadastro de professor/aluno/admin de unidade.
// Cria a PESSOA (sem senha), o VÍNCULO no papel e o CONVITE de ativação.
// v1 sem servidor de e-mail: o admin baixa o TXT dos e-mails que seriam
// enviados (envio é ação explícita, nunca consequência escondida).
// ---------------------------------------------------------------------------

router.post("/admin/units/:unitId/people", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const { user, membership, invite } = await createPersonWithInvite({
            name: req.body?.name,
            email: req.body?.email,
            role: req.body?.role,
            unitId,
            civilIdValue: req.body?.civil_id || null,
            createdByUserId: uid(req),
        });
        log.info("UNITS", `person ${user.username} (${user.email}) role=${req.body?.role} unit=${unitId} invite=${invite ? "yes" : "no"} by=${req.session.user.username}`);
        res.json({
            user: { id: user.id, username: user.username, email: user.email, display_name: user.display_name },
            membership_created: !!membership,
            invite: invite ? { id: invite.id, state: invite.state, expires_at: invite.expires_at } : null,
        });
    } catch (err) { return httpErr(res, err); }
});

router.get("/admin/units/:unitId/invites", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const invites = await listUnitInvites(unitId);
        res.json({ invites: invites.map(({ token, ...rest }) => rest) });
    } catch (err) { return httpErr(res, err); }
});

// TXT dos e-mails que seriam enviados (convites pendentes da unidade).
router.get("/admin/units/:unitId/invites.txt", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const invites = await listUnitInvites(unitId);
        const base = `${req.protocol}://${req.get("host")}`;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="convites-unidade-${unitId}.txt"`);
        res.send(buildInviteEmailsText(invites, base));
    } catch (err) { return httpErr(res, err); }
});

// (Re)emitir convite para uma pessoa da unidade: invalida o link anterior e
// gera um novo (regra da spec).
router.post("/admin/units/:unitId/people/:userId/invite", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    const userId = Number(req.params.userId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const member = await pool.query(
            `SELECT 1 FROM memberships WHERE user_id = $1 AND unit_id = $2 LIMIT 1`,
            [userId, unitId]
        );
        if (member.rowCount === 0) return res.status(404).json({ error: "person_not_in_unit" });
        const invite = await issueInvite({ userId, createdByUserId: uid(req) });
        log.info("UNITS", `invite resent user=${userId} unit=${unitId} by=${req.session.user.username}`);
        res.json({ invite: { id: invite.id, state: invite.state, expires_at: invite.expires_at } });
    } catch (err) { return httpErr(res, err); }
});

router.post("/admin/units/:unitId/invites/:inviteId/cancel", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        await cancelInvite(Number(req.params.inviteId));
        res.json({ ok: true });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Pacotes (Gate B): catálogo, alocação raiz, cascata, leitura de contadores
// ---------------------------------------------------------------------------

// Catálogo de templates (a partir do registry em memória, fonte = filesystem).
router.get("/admin/packages", requireAdmin, (_req, res) => {
    res.json({ templates: listPackageSpecs() });
});

router.get("/admin/units/:unitId/entitlements", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canViewUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        res.json({
            allocations: await listUnitEntitlements(unitId),
            rollup: await unitEntitlementRollup(unitId),
        });
    } catch (err) { return httpErr(res, err); }
});

// Concessão RAIZ de N pacotes numa unidade (topo da cascata). Só admin_global.
router.post("/admin/units/:unitId/packages/allocate", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await isGlobalAdmin(uid(req)))) return res.status(403).json({ error: "forbidden" });
        const r = await allocateRoot({
            templateKey: req.body?.template_key,
            unitId,
            packages: req.body?.packages,
            grantedByUserId: uid(req),
        });
        log.info("UNITS", `pkg root-alloc template=${req.body?.template_key} n=${req.body?.packages} unit=${unitId} by=${req.session.user.username}`);
        res.json({ allocation_id: r.allocationId });
    } catch (err) { return httpErr(res, err); }
});

// DELEGA pacotes de uma allocation-pai para uma unidade filha (cascata). Exige
// poder de admin na unidade filha (que, por herança, cobre a sub-árvore do pai).
router.post("/admin/units/:unitId/packages/delegate", requireAdmin, json, async (req, res) => {
    const childUnitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), childUnitId))) return res.status(403).json({ error: "forbidden" });
        const r = await allocateToChild({
            parentAllocationId: Number(req.body?.parent_allocation_id),
            childUnitId,
            packages: req.body?.packages,
            grantedByUserId: uid(req),
        });
        log.info("UNITS", `pkg delegate parentAlloc=${req.body?.parent_allocation_id} n=${req.body?.packages} child=${childUnitId} by=${req.session.user.username}`);
        res.json({ allocation_id: r.allocationId });
    } catch (err) { return httpErr(res, err); }
});

// DEVOLVE pacotes não usados de uma allocation desta unidade para a
// allocation-pai (libera saldo na unidade de cima — espelho da delegação).
router.post("/admin/units/:unitId/packages/return", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const allocationId = Number(req.body?.allocation_id);
        const owns = await pool.query(
            `SELECT 1 FROM package_allocations WHERE id = $1 AND unit_id = $2`,
            [allocationId, unitId]
        );
        if (owns.rowCount === 0) return res.status(404).json({ error: "allocation_not_found_in_unit" });
        const r = await returnToParent({ childAllocationId: allocationId, packages: req.body?.packages });
        log.info("UNITS", `pkg return alloc=${allocationId} n=${req.body?.packages} unit=${unitId} by=${req.session.user.username}`);
        res.json({ returned: r.returned, parent_allocation_id: r.parentAllocationId });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Import CSV (integração gradual — degrau 1). Formato mínimo, sem dependência:
// cabeçalho name,parent_name,label,budget_usd — uma unidade por linha. parent_name
// deve referir uma unidade já existente OU criada numa linha anterior. Cria com
// source='imported'. Só admin_global (cria raízes).
// ---------------------------------------------------------------------------
router.post("/admin/units/import-csv", requireAdmin, express.text({ type: "*/*", limit: "256kb" }), async (req, res) => {
    try {
        if (!(await isGlobalAdmin(uid(req)))) return res.status(403).json({ error: "forbidden" });
        const lines = String(req.body || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) return res.status(400).json({ error: "csv_empty" });
        const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
        const iName = header.indexOf("name");
        const iParent = header.indexOf("parent_name");
        const iLabel = header.indexOf("label");
        const iBudget = header.indexOf("budget_usd");
        const iClass = header.indexOf("is_class");
        if (iName < 0) return res.status(400).json({ error: "csv_missing_name_column" });

        const byName = new Map((await listUnits()).map((u) => [u.name, u.id]));
        const created = [];
        for (const line of lines.slice(1)) {
            const cols = line.split(",").map((c) => c.trim());
            const name = cols[iName];
            if (!name) continue;
            const parentName = iParent >= 0 ? cols[iParent] : "";
            const parentId = parentName ? (byName.get(parentName) ?? null) : null;
            if (parentName && parentId == null) {
                return res.status(400).json({ error: `parent_not_found: "${parentName}" (linha "${name}")` });
            }
            const budget = iBudget >= 0 && cols[iBudget] ? Number(cols[iBudget]) : null;
            const isClass = iClass >= 0 && /^(true|1|sim|x)$/i.test(cols[iClass] || "");
            const unit = await createUnit({
                name, parentId, label: iLabel >= 0 ? cols[iLabel] || null : null,
                isClass, source: "imported",
            });
            // Teto do CSV = reserva contra o saldo do pai (mesma regra da criação).
            if (budget != null) {
                try {
                    await setUnitBudgetReserved(unit.id, budget);
                } catch (err) {
                    await pool.query(`DELETE FROM units WHERE id = $1`, [unit.id]).catch(() => {});
                    err.message = `${err.message} (linha "${name}")`;
                    throw err;
                }
            }
            byName.set(name, unit.id);
            created.push({ id: unit.id, name: unit.name });
        }
        log.info("UNITS", `csv import created=${created.length} by=${req.session.user.username}`);
        res.json({ created });
    } catch (err) { return httpErr(res, err); }
});

export default router;

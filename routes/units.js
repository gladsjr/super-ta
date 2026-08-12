// Rotas da camada institucional (auth via sessão). Unidades (árvore), papéis
// (memberships), orçamento US$ por unidade (Gate A) e pacotes (Gate B:
// alocação/cascata + leitura de contadores). Ver docs/access-model.md.
//
// Coexistência: NÃO toca nos gates de token. Tudo aqui é aditivo e por sessão.
// Autorização em camadas:
//  - requireAuth: precisa estar logado.
//  - canAdminUnit(user, unit): admin_global OU admin_unidade num ancestral →
//    é assim que a delegação desce a sub-árvore (nunca para um irmão).

import express from "express";
import { requireAdmin } from "../lib/middleware.js";
import { getUserByLogin, requireAuth } from "../auth.js";
import {
    listUnits, getUnit, createUnit, renameUnit, setUnitActive, setUnitLabel, listUnitLabels,
} from "../lib/units.js";
import {
    isGlobalAdmin, canAdminUnit, resolveEffectiveRoles,
    listUnitMembers, addMembership, removeMembership, listRoles, listAvailablePeople,
} from "../lib/rbac.js";
import { getUnitBalance, setUnitBudgetReserved } from "../lib/billing.js";
import {
    allocateRoot, allocateToChild, returnToParent, listUnitEntitlements,
    unitEntitlementRollup, listPackageSpecs, classAvailableTypes,
} from "../lib/packages.js";
import { pool } from "../auth.js";
import {
    createPersonWithInvite, issueInvite, cancelInvite, listUnitInvites,
    buildInviteEmailsText,
} from "../lib/invites.js";
import { acceptedProviderMap, unitAcceptsProvider } from "../lib/tenants.js";
import { publicBaseUrl } from "../lib/publicUrl.js";
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

// Lista plana da árvore COMPLETA — só admin global (o seletor do /admin usa).
// A visão escopada por vínculo é /api/my-units, abaixo.
router.get("/admin/units", requireAdmin, async (_req, res) => {
    try {
        res.json({ units: await listUnits() });
    } catch (err) { return httpErr(res, err); }
});

// Tipos de unidade (rótulos). Lookup estático — qualquer admin pode ler p/ montar
// o <select> de tipo. 'turma' é o especial (dispara is_class).
router.get("/admin/unit-labels", requireAdmin, async (_req, res) => {
    try {
        res.json({ labels: await listUnitLabels() });
    } catch (err) { return httpErr(res, err); }
});

// Cria unidade. Raiz (sem parent) exige admin_global; filha exige admin na unidade-pai.
router.post("/admin/units", requireAuth, json, async (req, res) => {
    const parentId = req.body?.parent_id ?? null;
    try {
        if (parentId == null) {
            if (!(await isGlobalAdmin(uid(req)))) return res.status(403).json({ error: "forbidden" });
            // Raiz NUNCA sem limite: a raiz é a AQUISIÇÃO — nasce com teto US$, que
            // desce por herança para toda a sub-árvore (filha sem teto puxa do saldo
            // do ancestral). Assim sempre há um limite efetivo. Ver access-model.md.
            const b = req.body?.budget_usd;
            if (b == null || b === "" || !(Number(b) > 0)) {
                return res.status(400).json({ error: "root_requires_budget" });
            }
        } else {
            if (!(await canAdminUnit(uid(req), Number(parentId)))) return res.status(403).json({ error: "forbidden" });
        }
        const unit = await createUnit({
            name: req.body?.name,
            parentId: parentId == null ? null : Number(parentId),
            labelId: req.body?.label_id != null && req.body.label_id !== "" ? Number(req.body.label_id) : null,
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

// "Configurar de cima" (decisão de 06/08/2026): NOME, TIPO (rótulo) e ORÇAMENTO de
// uma unidade são definidos pelo admin do PAI dela — o admin de X não mexe no
// nome/tipo/teto de X, e sim nos dos filhos de X. Na raiz isso vira "só admin
// global" (é aquisição, envolve pagamento — equipe ORATIA). Já "operar a própria
// unidade" (membros, ativar) é do admin da própria unidade. Admin global faz tudo.
// Obs.: o TIPO virou "configurar de cima" com a migration 070 (turma deixou de ser
// um flag operável na unidade e passou a ser um rótulo, como o nome).
async function canConfigureFromAbove(userId, unitId) {
    if (await isGlobalAdmin(userId)) return true;
    const u = await getUnit(unitId);
    if (!u || u.parent_id == null) return false; // raiz → só global
    return canAdminUnit(userId, u.parent_id);
}

router.patch("/admin/units/:unitId", requireAuth, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        // nome = configurar de cima
        if (typeof req.body?.name === "string") {
            if (!(await canConfigureFromAbove(uid(req), unitId))) return res.status(403).json({ error: "forbidden_from_above" });
            const u = await renameUnit(unitId, req.body.name);
            return res.json({ unit: u });
        }
        // tipo (rótulo, inclui turma) = configurar de cima
        if ("label_id" in (req.body || {})) {
            if (!(await canConfigureFromAbove(uid(req), unitId))) return res.status(403).json({ error: "forbidden_from_above" });
            const labelId = req.body.label_id != null && req.body.label_id !== "" ? Number(req.body.label_id) : null;
            const u = await setUnitLabel(unitId, labelId);
            return res.json({ unit: u });
        }
        // ativar/desativar = operar a própria unidade
        if (typeof req.body?.is_active === "boolean") {
            if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
            const u = await setUnitActive(unitId, req.body.is_active);
            return res.json({ unit: u });
        }
        return res.status(400).json({ error: "nothing to update" });
    } catch (err) { return httpErr(res, err); }
});

// Teto de US$ desta unidade (Gate A — RESERVA contra o saldo do pai; reduzir
// devolve; null remove o teto). "Configurar de cima": editável pelo admin do PAI
// (é o saldo dele que a reserva mexe); na RAIZ, só admin global (aquisição).
router.put("/admin/units/:unitId/budget", requireAuth, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    const raw = req.body?.budget_usd;
    try {
        const unit = await getUnit(unitId);
        if (!unit) return res.status(404).json({ error: "unit not found" });
        if (!(await canConfigureFromAbove(uid(req), unitId))) return res.status(403).json({ error: "forbidden_from_above" });
        const budget = raw === null || raw === "" || raw === undefined ? null : Number(raw);
        const u = await setUnitBudgetReserved(unitId, budget);
        res.json({ unit: u });
    } catch (err) { return httpErr(res, err); }
});

// Saldo em US$ (reserva/comprometido). Assunto de GESTÃO: admin da unidade ou
// professor dela — aluno não consulta orçamento.
router.get("/admin/units/:unitId/budget", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        const roles = await resolveEffectiveRoles(uid(req), unitId);
        const allowed = (await canAdminUnit(uid(req), unitId)) || roles.has("professor");
        if (!allowed) return res.status(403).json({ error: "forbidden" });
        const balance = await getUnitBalance(unitId);
        if (!balance) return res.status(404).json({ error: "unit not found" });
        res.json({ balance });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Membros & papéis (RBAC)
// ---------------------------------------------------------------------------

// A lista de membros (nomes, papéis, E-MAILS) é dado pessoal — só quem ADMINISTRA
// a unidade vê (issue #162). Antes bastava canViewUnit, então aluno/professor em
// consulta recebiam o diretório inteiro com e-mails de terceiros (menor privilégio
// violado). Roster por turma p/ professor, com e-mails ocultos, fica p/ depois.
router.get("/admin/units/:unitId/members", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        res.json({ members: await listUnitMembers(unitId), roles: await listRoles() });
    } catch (err) { return httpErr(res, err); }
});

// DISPONIBILIDADE (não é acesso): candidatos ao papel `role` nesta unidade,
// vindos do ancestral mais próximo que tiver gente nesse papel (mãe esconde
// avó). Serve o fluxo de inscrição de aluno / atribuição de professor.
router.get("/admin/units/:unitId/available-people", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const role = String(req.query.role || "aluno");
        res.json(await listAvailablePeople(unitId, role));
    } catch (err) { return httpErr(res, err); }
});

// Vincula papel a uma pessoa nesta unidade. Aceita user_id OU login (email/username).
router.post("/admin/units/:unitId/members", requireAuth, json, async (req, res) => {
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

router.delete("/admin/units/:unitId/members/:membershipId", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        await removeMembership(Number(req.params.membershipId));
        res.json({ ok: true });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Visão POR PAPEL (decisão de 04/08/2026): cada pessoa enxerga só o seu
// recorte da árvore. admin_global vê tudo com gestão; admin_unidade vê a sua
// sub-árvore com gestão; professor e aluno veem os nós onde têm vínculo, em
// CONSULTA. access: 'admin' | 'view'.
// ---------------------------------------------------------------------------

// CONTEXTO (decisão de 04/08/2026): a pessoa atua dentro de UMA instituição
// por vez — a raiz da árvore onde tem vínculo. Um contexto só → entra direto;
// vários → escolhe no login (POST /api/my-context; fica na sessão até o
// logout — trocar de instituição é outro login, sem seletor no topo). Papéis
// se SOMAM dentro do contexto (professor numa turma + aluno noutra convivem).
// prov = { key, kind } do login (session.authProvider). Só entram os vínculos
// cujas unidades ACEITAM esse provedor (unit_auth_policies; unidade sem política
// aceita o realm aberto). É a trava da Q2: senha local no @fgv.br não revela as
// unidades da FGV (que só aceitam o SSO da FGV).
async function resolveContexts(userId, prov = { key: "local", kind: "local" }) {
    const all = await listUnits();
    const byId = new Map(all.map((u) => [u.id, u]));
    const rootOf = (id) => {
        let cur = byId.get(id);
        while (cur && cur.parent_id != null && byId.has(cur.parent_id)) cur = byId.get(cur.parent_id);
        return cur?.id ?? id;
    };
    const acceptMap = await acceptedProviderMap();
    const raw = await pool.query(
        `SELECT m.unit_id, r.key FROM memberships m JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.unit_id IS NOT NULL`,
        [userId]
    );
    const memberships = raw.rows.filter((m) =>
        unitAcceptsProvider(acceptMap, m.unit_id, prov.key, prov.kind)
    );
    const contexts = new Map(); // rootId → Set(roles em toda a árvore)
    for (const m of memberships) {
        const root = rootOf(m.unit_id);
        if (!contexts.has(root)) contexts.set(root, new Set());
        contexts.get(root).add(m.key);
    }
    return { all, byId, memberships, contexts, rootOf };
}

router.get("/api/my-units", requireAuth, async (req, res) => {
    try {
        const userId = uid(req);
        if (await isGlobalAdmin(userId)) {
            const all = await listUnits();
            return res.json({
                is_global_admin: true,
                units: all.map((u) => ({ ...u, access: "admin", my_roles: ["admin_global"] })),
            });
        }
        const { all, byId, memberships, contexts, rootOf } = await resolveContexts(userId, req.session.authProvider);
        if (contexts.size === 0) {
            return res.json({ is_global_admin: false, no_membership: true, units: [] });
        }
        let ctx = req.session.contextRootId;
        if (!contexts.has(ctx)) ctx = null;
        if (!ctx && contexts.size === 1) ctx = [...contexts.keys()][0];
        if (!ctx) {
            return res.json({
                is_global_admin: false,
                needs_context: true,
                contexts: [...contexts.entries()].map(([rootId, roles]) => ({
                    root_id: rootId, name: byId.get(rootId)?.name || `#${rootId}`, roles: [...roles],
                })),
            });
        }
        const kids = new Map();
        for (const u of all) {
            if (u.parent_id != null) {
                if (!kids.has(u.parent_id)) kids.set(u.parent_id, []);
                kids.get(u.parent_id).push(u.id);
            }
        }
        const visible = new Map(); // id → { access, roles:Set }
        const mark = (id, access, role = null) => {
            const cur = visible.get(id) || { access: "context", roles: new Set() };
            // precedência: admin > view > context
            if (access === "admin" || (access === "view" && cur.access !== "admin")) cur.access = access;
            if (role) cur.roles.add(role);
            visible.set(id, cur);
        };
        for (const m of memberships) {
            if (rootOf(m.unit_id) !== ctx) continue; // só o contexto escolhido
            if (m.key === "admin_unidade") {
                const queue = [m.unit_id];
                mark(m.unit_id, "admin", m.key);
                while (queue.length) {
                    const id = queue.shift();
                    for (const kid of kids.get(id) || []) {
                        mark(kid, "admin");
                        queue.push(kid);
                    }
                }
            } else {
                mark(m.unit_id, "view", m.key); // professor/aluno: consulta no nó
            }
        }
        // Caminho até a raiz: ancestrais viram nós de CONTEXTO (nome visível,
        // sem acesso) — o professor da turma vê "Mackenzie > Curso > Turma".
        for (const id of [...visible.keys()]) {
            let cur = byId.get(id);
            while (cur && cur.parent_id != null && byId.has(cur.parent_id)) {
                cur = byId.get(cur.parent_id);
                if (!visible.has(cur.id)) mark(cur.id, "context");
            }
        }
        const units = all
            .filter((u) => visible.has(u.id))
            .map((u) => ({
                ...u,
                access: visible.get(u.id).access,
                my_roles: [...visible.get(u.id).roles],
            }));
        res.json({
            is_global_admin: false,
            context_root_id: ctx,
            context_name: byId.get(ctx)?.name || null,
            units,
        });
    } catch (err) { return httpErr(res, err); }
});

// Escolhe o contexto (instituição) da sessão. Válido até o logout.
router.post("/api/my-context", requireAuth, json, async (req, res) => {
    try {
        const rootId = Number(req.body?.root_id);
        const { contexts, byId } = await resolveContexts(uid(req), req.session.authProvider);
        if (!contexts.has(rootId)) return res.status(403).json({ error: "not_your_context" });
        req.session.contextRootId = rootId;
        req.session.save(() => res.json({ ok: true, context_root_id: rootId, context_name: byId.get(rootId)?.name }));
    } catch (err) { return httpErr(res, err); }
});

// Trabalhos de uma TURMA, com o link certo pelo papel: quem gerencia
// (admin/professor da turma) recebe o work_token (abre /w/:token — a tela de
// professor existente); aluno recebe SÓ o token do próprio envio, se houver
// (abre /s/:token — a tela de envio existente). work_token é capacidade plena:
// NUNCA vai para aluno.
router.get("/admin/units/:unitId/works", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        const userId = uid(req);
        const isGlobal = await isGlobalAdmin(userId);
        // A unidade tem de aceitar o provedor do login (mesma trava do my-units).
        if (!isGlobal) {
            const acceptMap = await acceptedProviderMap();
            const p = req.session.authProvider || { key: "local", kind: "local" };
            if (!unitAcceptsProvider(acceptMap, unitId, p.key, p.kind)) return res.status(403).json({ error: "forbidden" });
        }
        const roles = await resolveEffectiveRoles(userId, unitId);
        // VER a lista: qualquer vínculo com a unidade (admin/professor/aluno) ou global.
        const canView = isGlobal || roles.size > 0;
        if (!canView) return res.status(403).json({ error: "forbidden" });
        // EDITAR trabalhos (token + criar): só professor DA turma ou admin global.
        // Admin de unidade (não-global) vê em consulta, não edita — decisão de 06/08.
        const canEdit = isGlobal || roles.has("professor");
        const works = await pool.query(
            `SELECT id, work_token, name, kind, interview_variant, is_active, created_at
               FROM works WHERE unit_id = $1 ORDER BY created_at DESC`,
            [unitId]
        );
        const out = [];
        for (const w of works.rows) {
            const item = { name: w.name, kind: w.kind, interview_variant: w.interview_variant, is_active: w.is_active };
            if (canEdit) {
                item.work_token = w.work_token;
            } else if (roles.has("aluno")) {
                const sub = await pool.query(
                    `SELECT submission_token FROM submissions
                      WHERE work_id = $1 AND student_user_id = $2 LIMIT 1`,
                    [w.id, userId]
                );
                item.my_submission_token = sub.rows[0]?.submission_token || null;
            }
            out.push(item);
        }
        // Tipos disponíveis (por cota de pacote) para quem cria trabalho — some o
        // conceito de "pacote"; o professor vê "prova oral: 3 · profunda: 5…".
        const availableTypes = canEdit ? await classAvailableTypes(unitId) : [];
        res.json({ can_edit: canEdit, works: out, available_types: availableTypes });
    } catch (err) { return httpErr(res, err); }
});

// ---------------------------------------------------------------------------
// Pessoas & convites — o cadastro de professor/aluno/admin de unidade.
// Cria a PESSOA (sem senha), o VÍNCULO no papel e o CONVITE de ativação.
// v1 sem servidor de e-mail: o admin baixa o TXT dos e-mails que seriam
// enviados (envio é ação explícita, nunca consequência escondida).
// ---------------------------------------------------------------------------

router.post("/admin/units/:unitId/people", requireAuth, json, async (req, res) => {
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

router.get("/admin/units/:unitId/invites", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const invites = await listUnitInvites(unitId);
        const base = publicBaseUrl(req);
        // Sem servidor de e-mail, o admin precisa do LINK para enviar à mão — só
        // dos convites pendentes (os já usados/cancelados não têm link ativo).
        res.json({
            invites: invites.map(({ token, ...rest }) => ({
                ...rest,
                activation_link: rest.state === "pendente" ? `${base}/ativar?token=${token}` : null,
            })),
        });
    } catch (err) { return httpErr(res, err); }
});

// TXT dos e-mails que seriam enviados (convites pendentes da unidade).
router.get("/admin/units/:unitId/invites.txt", requireAuth, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        if (!(await canAdminUnit(uid(req), unitId))) return res.status(403).json({ error: "forbidden" });
        const invites = await listUnitInvites(unitId);
        const base = publicBaseUrl(req);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="convites-unidade-${unitId}.txt"`);
        res.send(buildInviteEmailsText(invites, base));
    } catch (err) { return httpErr(res, err); }
});

// (Re)emitir convite para uma pessoa da unidade: invalida o link anterior e
// gera um novo (regra da spec).
router.post("/admin/units/:unitId/people/:userId/invite", requireAuth, json, async (req, res) => {
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

router.post("/admin/units/:unitId/invites/:inviteId/cancel", requireAuth, json, async (req, res) => {
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

router.get("/admin/units/:unitId/entitlements", requireAuth, async (req, res) => {
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
router.post("/admin/units/:unitId/packages/delegate", requireAuth, json, async (req, res) => {
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
router.post("/admin/units/:unitId/packages/return", requireAuth, json, async (req, res) => {
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
// source='imported'. Só admin_global (cria raízes). A coluna `label` casa por
// KEY ou NOME do rótulo (case-insensitive); `is_class=true` força tipo 'turma'.
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

        // Resolve rótulo do CSV (key ou nome) → id. turma tem tratamento especial.
        const labels = await listUnitLabels();
        const labelByKey = new Map(labels.map((l) => [l.key, l.id]));
        const labelByName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
        const turmaId = labelByKey.get("turma") ?? null;
        const resolveLabelId = (raw, isClass) => {
            if (isClass) return turmaId;
            const s = String(raw || "").trim().toLowerCase();
            if (!s) return null;
            return labelByKey.get(s) ?? labelByName.get(s) ?? null;
        };

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
            const labelId = resolveLabelId(iLabel >= 0 ? cols[iLabel] : null, isClass);
            const unit = await createUnit({
                name, parentId, labelId, source: "imported",
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

// Rotas administrativas (auth via sessão, gate `requireAdmin`).
// Gerencia works (criação, listagem, orçamento), defaults expostos pro
// frontend, e CRUD básico de usuários.

import express from "express";
import crypto from "crypto";
import { requireAdmin, sanitizeLabel } from "../lib/middleware.js";
import { listGlobalAdmins, createUser, deleteUser, changeOwnPassword, requireAuth, pool } from "../auth.js";
import { isGlobalAdmin, resolveEffectiveRoles, addMembership } from "../lib/rbac.js";
import { getUnit } from "../lib/units.js";
import { getPackageSpec, releaseForWork, templateForClassType } from "../lib/packages.js";
import * as db from "../lib/db.js";
import * as scenarioStore from "../lib/scenarios/store.js";
import { DEFAULT_WORK_BUDGET_USD } from "../lib/config.js";
import log from "../lib/logger.js";
import { getProctorQueueSnapshot, setProctorConcurrency, enqueueProctor, cancelProctor, prioritizeProctor, MAX_CONCURRENCY } from "../lib/proctorQueue.js";
import { jobsSnapshot } from "../lib/jobs.js";
import { RETRANSCRIBE_ENGINE } from "../lib/config.js";
import { getActiveRealtimeSessions } from "../lib/realtimeBridge.js";
import { getMemoryStats } from "../lib/opsStats.js";

const router = express.Router();

router.get("/admin/works", requireAdmin, async (_req, res) => {
    try {
        const works = await db.listWorks();
        res.json({ works });
    } catch (err) {
        log.error("ADMIN", `list works failed: ${err.message}`);
        res.status(500).json({ error: "failed to list works" });
    }
});

// requireAuth (não requireAdmin): professor institucional cria trabalho NA SUA
// turma — a checagem fina (turma + papel local) está abaixo. Sem unidade
// (modo token) continua exigindo admin_global.
router.post("/admin/works", requireAuth, async (req, res) => {
    let name;
    try { name = sanitizeLabel(req.body?.name); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    // Orçamento opcional na criação; se ausente, usa o default de pricing.yaml.
    let budget = DEFAULT_WORK_BUDGET_USD;
    if (req.body?.budget_usd !== undefined && req.body?.budget_usd !== null && req.body?.budget_usd !== "") {
        const parsed = Number(req.body.budget_usd);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return res.status(400).json({ error: "budget_usd must be a non-negative number" });
        }
        budget = parsed;
    }
    // Tipo do trabalho: scenario (multi-interação, default dos novos), interview
    // (entrevista legada) ou oral_realtime (prova oral). Coexistência.
    const valid = ["interview", "oral_realtime", "scenario"];
    let kind = valid.includes(req.body?.kind) ? req.body.kind : "scenario";

    // Linkagem institucional OPCIONAL. Ausente = trabalho token-only (hoje).
    const unitId = req.body?.unit_id != null ? Number(req.body.unit_id) : null;
    const ownerUserId = req.body?.owner_user_id != null ? Number(req.body.owner_user_id) : null;
    // Binding de pacote (Portão B): item_key (o TIPO) é o que o professor escolhe;
    // o template é resolvido da turma (fluxo por tipo). template_key explícito ainda
    // é aceito (fluxo admin). item principal.
    let templateKey = req.body?.template_key || null;
    const itemKey = req.body?.item_key || null;

    try {
        // Trabalho é da TURMA: só unidades is_class recebem trabalho, e o
        // criador precisa ser professor ATRIBUÍDO à turma (papel local — sem
        // herança) ou admin dela/de um ancestral (decisão de 04/08/2026).
        if (unitId != null) {
            const unit = await getUnit(unitId);
            if (!unit) return res.status(404).json({ error: "unit_not_found" });
            if (!unit.is_class) return res.status(400).json({ error: "unit_not_class" });
            // Criar trabalho na turma = professor ATRIBUÍDO à turma ou admin global
            // (decisão de 06/08: trabalho é do professor; admin de unidade não cria).
            if (!(await isGlobalAdmin(req.session.user.id))) {
                const roles = await resolveEffectiveRoles(req.session.user.id, unitId);
                if (!roles.has("professor")) {
                    return res.status(403).json({ error: "forbidden_unit" });
                }
            }
        } else if (!(await isGlobalAdmin(req.session.user.id))) {
            return res.status(403).json({ error: "forbidden_tokenless_work" });
        }
        // Fluxo por TIPO (professor): veio item_key sem template — resolve o pacote
        // da turma que cobre esse tipo (único pela trava de sobreposição).
        if (!templateKey && itemKey && unitId != null) {
            templateKey = await templateForClassType(unitId, itemKey);
            if (!templateKey) return res.status(400).json({ error: "type_not_in_package" });
        }
        // Resolve o item do pacote (se houver) e alinha o kind ao item.
        let lockedCounter = null;
        if (templateKey && itemKey) {
            const spec = getPackageSpec(templateKey);
            const item = spec?.items?.find((i) => i.key === itemKey);
            if (!item) return res.status(400).json({ error: "invalid_package_item" });
            if (unitId == null) return res.status(400).json({ error: "package_requires_unit" });
            kind = item.kind;
            lockedCounter = spec.counters.find((c) => c.item_key === itemKey) || null;
        }

        const work = await db.createWork(name, budget, kind, { unitId, ownerUserId });
        if (lockedCounter) {
            // Variante vem do ITEM do pacote (interview: messages|realtime) —
            // é ela que distingue a entrevista simplificada (realtime) da profunda.
            const item = getPackageSpec(templateKey)?.items?.find((i) => i.key === itemKey);
            await db.applyWorkPackageBinding(work.id, templateKey, itemKey, lockedCounter.locks_json, item?.variant || null);
        }
        // Trabalho multi-interação nasce com um cenário vazio vinculado (work_id).
        if (kind === "scenario") {
            await scenarioStore.saveScenario({ name: work.name, description: "", personas: [], interactions: [], work_id: work.id });
        }
        log.info("ADMIN", `work created token=${work.work_token} name="${work.name}" kind=${kind} budget=$${Number(work.budget_usd).toFixed(2)} unit=${unitId ?? "-"} pkg=${templateKey ? `${templateKey}/${itemKey}` : "-"} by=${req.session.user.username}`);
        res.json({ work });
    } catch (err) {
        log.error("ADMIN", `create work failed: ${err.message}`);
        res.status(500).json({ error: "failed to create work" });
    }
});

router.patch("/admin/works/:workToken/active", requireAdmin, express.json({ limit: "8kb" }), async (req, res) => {
    const workToken = String(req.params.workToken || "").toLowerCase();
    if (typeof req.body?.is_active !== "boolean") {
        return res.status(400).json({ error: "is_active (boolean) required" });
    }
    try {
        const work = await db.getWorkByToken(workToken);
        if (!work) return res.status(404).json({ error: "work not found" });
        const newValue = await db.setWorkActive(work.id, req.body.is_active);
        log.info("ADMIN", `work ${newValue ? "activated" : "deactivated"} token=${workToken} by=${req.session.user.username}`);
        res.json({ ok: true, work_token: workToken, is_active: newValue });
    } catch (err) {
        log.error("ADMIN", `set work active failed: ${err.message}`);
        res.status(500).json({ error: "failed to update active flag" });
    }
});

// Apaga o trabalho e tudo encadeado (submissions, work_cost_events via CASCADE).
// Irreversível. UI exige confirmação dupla com o nome do trabalho.
router.delete("/admin/works/:workToken", requireAdmin, async (req, res) => {
    const workToken = String(req.params.workToken || "").toLowerCase();
    try {
        const work = await db.getWorkByToken(workToken);
        if (!work) return res.status(404).json({ error: "work not found" });
        // Devolve ao pool os assentos dos tokens NÃO usados ANTES de apagar (o
        // cascade removeria as reservas sem creditar de volta). Devolução + delete
        // numa ÚNICA transação (issue #145): falha no delete desfaz a devolução —
        // nada de reembolso de cota sem apagar o trabalho. Ver lib/packages.js.
        const client = await pool.connect();
        let ok;
        try {
            await client.query("BEGIN");
            await releaseForWork(work.id, client);
            ok = await db.deleteWork(work.id, client);
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }
        if (!ok) return res.status(404).json({ error: "work not found" });
        log.info("ADMIN", `work DELETED token=${workToken} name="${work.name}" by=${req.session.user.username}`);
        res.json({ ok: true, deleted: workToken });
    } catch (err) {
        log.error("ADMIN", `delete work failed: ${err.message}`);
        res.status(500).json({ error: "failed to delete work" });
    }
});

// Renomeia o trabalho pelo admin. Mesma validação (sanitizeLabel: 80 chars, sem
// caracteres proibidos) da rota do professor `PATCH /w/:workToken/name`.
router.patch("/admin/works/:workToken/name", requireAdmin, express.json({ limit: "8kb" }), async (req, res) => {
    const workToken = String(req.params.workToken || "").toLowerCase();
    let name;
    try { name = sanitizeLabel(req.body?.name); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    try {
        const work = await db.getWorkByToken(workToken);
        if (!work) return res.status(404).json({ error: "work not found" });
        await db.renameWork(work.id, name);
        log.info("ADMIN", `work renamed token=${workToken} to="${name}" by=${req.session.user.username}`);
        res.json({ ok: true, work_token: workToken, name });
    } catch (err) {
        log.error("ADMIN", `rename work failed: ${err.message}`);
        res.status(500).json({ error: "failed to rename work" });
    }
});

router.patch("/admin/works/:workToken/budget", requireAdmin, express.json({ limit: "8kb" }), async (req, res) => {
    const workToken = String(req.params.workToken || "").toLowerCase();
    const parsed = Number(req.body?.budget_usd);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: "budget_usd must be a non-negative number" });
    }
    try {
        const work = await db.getWorkByToken(workToken);
        if (!work) return res.status(404).json({ error: "work not found" });
        const updated = await db.updateWorkBudget(work.id, parsed);
        log.info("ADMIN", `work budget updated token=${workToken} budget=$${Number(updated.budget_usd).toFixed(2)} by=${req.session.user.username}`);
        res.json({ ok: true, budget_usd: updated.budget_usd, spent_usd: updated.spent_usd });
    } catch (err) {
        log.error("ADMIN", `update work budget failed: ${err.message}`);
        res.status(500).json({ error: "failed to update budget" });
    }
});

// Defaults expostos para o frontend admin pré-preencher campos.
router.get("/admin/defaults", requireAdmin, (_req, res) => {
    res.json({ default_work_budget_usd: DEFAULT_WORK_BUDGET_USD });
});

// ---- User management (every authenticated user is an admin) ----
router.get("/admin/users", requireAdmin, async (_req, res) => {
    try {
        // Só admins GLOBAIS (equipe ORATIA) — não o diretório inteiro (issue #161).
        const users = await listGlobalAdmins();
        res.json({ users });
    } catch (err) {
        log.error("ADMIN", `list users failed: ${err.message}`);
        res.status(500).json({ error: "failed to list users" });
    }
});

// A tela "Usuários e senha" é a gestão da EQUIPE ORATIA: usuário criado aqui
// nasce admin_global (vínculo unit_id NULL — decisão de 04/08/2026). Contas de
// professor/aluno de instituição virão por convite/importação, não por aqui.
router.post("/admin/users", requireAdmin, async (req, res) => {
    try {
        const user = await createUser(req.body?.username, req.body?.password);
        await addMembership({ userId: user.id, unitId: null, role: "admin_global" });
        log.info("ADMIN", `user created username="${user.username}" (admin_global) by=${req.session.user.username}`);
        res.json({ user });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        log.error("ADMIN", `create user failed: ${err.message}`);
        res.status(500).json({ error: "failed to create user" });
    }
});

router.post("/admin/users/me/password", requireAdmin, async (req, res) => {
    try {
        await changeOwnPassword(
            req.session.user.id,
            req.body?.currentPassword,
            req.body?.newPassword
        );
        log.info("ADMIN", `user password changed username="${req.session.user.username}"`);
        res.json({ ok: true });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        log.error("ADMIN", `change password failed: ${err.message}`);
        res.status(500).json({ error: "failed to change password" });
    }
});

router.delete("/admin/users/:id", requireAdmin, async (req, res) => {
    try {
        const username = await deleteUser(req.params.id, req.session.user.id);
        log.info("ADMIN", `user deleted username="${username}" by=${req.session.user.username}`);
        res.json({ ok: true, deleted: username });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        log.error("ADMIN", `delete user failed: ${err.message}`);
        res.status(500).json({ error: "failed to delete user" });
    }
});

// --- Tokens do endpoint de análise (/api/analytics/query) ---
// Gerados AQUI, pelo admin logado (que já tem direito de acesso aos dados). O
// texto puro do token é devolvido UMA vez (na geração); o banco guarda só o
// hash. Validade fixa de 30 dias (migration 053). Ver routes/analytics.js.
router.post("/admin/analytics-tokens", requireAdmin, express.json({ limit: "8kb" }), async (req, res) => {
    try {
        const label = (typeof req.body?.label === "string" ? req.body.label.trim() : "").slice(0, 120) || null;
        const plaintext = "oratia_analytics_" + crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(plaintext).digest("hex");
        const tokenPrefix = plaintext.slice(0, 24); // "oratia_analytics_" + 7 chars
        const info = await db.createAnalyticsToken({ tokenHash, tokenPrefix, label, createdBy: req.session.user.username });
        log.info("ADMIN", `analytics token created id=${info.id} by=${req.session.user.username} expires=${info.expires_at}`);
        // token (texto puro) só aqui, uma única vez.
        res.json({ token: plaintext, info });
    } catch (err) {
        log.error("ADMIN", `create analytics token failed: ${err.message}`);
        res.status(500).json({ error: "failed to create analytics token" });
    }
});

router.get("/admin/analytics-tokens", requireAdmin, async (_req, res) => {
    try {
        res.json({ tokens: await db.listAnalyticsTokens() });
    } catch (err) {
        log.error("ADMIN", `list analytics tokens failed: ${err.message}`);
        res.status(500).json({ error: "failed to list analytics tokens" });
    }
});

router.post("/admin/analytics-tokens/:id/revoke", requireAdmin, async (req, res) => {
    try {
        const ok = await db.revokeAnalyticsToken(Number(req.params.id));
        if (!ok) return res.status(404).json({ error: "token não encontrado ou já revogado" });
        log.info("ADMIN", `analytics token revoked id=${req.params.id} by=${req.session.user.username}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("ADMIN", `revoke analytics token failed: ${err.message}`);
        res.status(500).json({ error: "failed to revoke analytics token" });
    }
});


// ---- Operações: fila de proctoring (issues #262/#263) ----

// Fotografia da fila + contadores. A fila vive em memória (proctorQueue); os
// dados de aluno/trabalho vêm do banco por id (enriquecimento sob demanda).
router.get("/admin/proctor/queue", requireAdmin, async (_req, res) => {
    try {
        const snap = getProctorQueueSnapshot();
        const ids = [...snap.running, ...snap.queued].map(i => i.submission_id);
        const info = await db.getProctorSubmissionInfo(ids);
        const byId = Object.fromEntries(info.map(r => [r.id, r]));
        const enrich = (i) => ({ ...i, ...(byId[i.submission_id] ? {
            student_label: byId[i.submission_id].student_label,
            is_test: byId[i.submission_id].is_test,
            work_name: byId[i.submission_id].work_name,
            work_token: byId[i.submission_id].work_token,
            kind: byId[i.submission_id].kind,
        } : {}) });
        const [stats, failures] = await Promise.all([db.getProctorStats(), db.listProctorFailures()]);
        res.json({
            concurrency: snap.concurrency, max_concurrency: MAX_CONCURRENCY,
            running: snap.running.map(enrich), queued: snap.queued.map(enrich),
            stats, failures,
        });
    } catch (err) {
        log.error("ADMIN", `proctor queue snapshot failed: ${err.message}`);
        res.status(500).json({ error: "falha ao ler a fila" });
    }
});

router.post("/admin/proctor/concurrency", requireAdmin, async (req, res) => {
    try {
        const v = await setProctorConcurrency(req.body?.value);
        log.info("ADMIN", `proctor concurrency=${v} by=${req.session.user.username}`);
        res.json({ ok: true, concurrency: v });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Reprocesso pelo admin (prioridade manual — fura fila sobre o automático).
router.post("/admin/proctor/:submissionId/reprocess", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.submissionId);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
        const info = await db.getProctorSubmissionInfo([id]);
        if (!info.length) return res.status(404).json({ error: "submissão não encontrada" });
        enqueueProctor(id, { priority: "manual", tokenForLog: info[0].submission_token }).catch(() => {});
        log.info("ADMIN", `proctor reprocess sub=${info[0].submission_token} by=${req.session.user.username}`);
        res.status(202).json({ ok: true, queued: true });
    } catch (err) {
        log.error("ADMIN", `proctor reprocess failed: ${err.message}`);
        res.status(500).json({ error: "falha ao enfileirar" });
    }
});

// Dashboard de Operações (issue #265): alunos ativos por tipo + memória.
// Voz ao vivo vem do registro de sessões do relay (exato); entrevista por
// mensagens não tem sessão — definição operacional: atividade nos últimos
// 10 min (a tela exibe a definição para o número não parecer errado).
router.get("/admin/ops/dashboard", requireAdmin, async (_req, res) => {
    try {
        const voice = getActiveRealtimeSessions(); // { ORAL_RELAY: n, LIVE_RELAY: n }
        const messages = await db.countActiveMessageInterviews(10);
        const snap = getProctorQueueSnapshot();
        res.json({
            active: {
                oral_realtime: voice.ORAL_RELAY || 0,
                interview_realtime: voice.LIVE_RELAY || 0,
                interview_messages: messages,
                messages_window_min: 10,
            },
            memory: getMemoryStats(),
            analyses: { running: snap.running.length, queued: snap.queued.length },
            // Fila de jobs do banco (#289, corte 3): contagens por tipo/status.
            // best-effort — sem a migration 078 o dashboard segue sem o bloco.
            jobs: await jobsSnapshot().then(rows => ({ engine: RETRANSCRIBE_ENGINE, rows })).catch(() => null),
        });
    } catch (err) {
        log.error("ADMIN", `ops dashboard failed: ${err.message}`);
        res.status(500).json({ error: "falha ao ler o dashboard" });
    }
});

// Cancela um item AINDA NA FILA (running não é interrompido — só termina).
router.post("/admin/proctor/:submissionId/cancel", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.submissionId);
        const ok = await cancelProctor(id, `admin ${req.session.user.username}`);
        if (!ok) return res.status(409).json({ error: "item não está na fila nem rodando (já concluído?)" });
        res.json({ ok: true });
    } catch (err) {
        log.error("ADMIN", `proctor cancel failed: ${err.message}`);
        res.status(500).json({ error: "falha ao cancelar" });
    }
});

// Fura fila (#272): item enfileirado vai para a cabeça (prioridade manual).
router.post("/admin/proctor/:submissionId/prioritize", requireAdmin, (req, res) => {
    const ok = prioritizeProctor(Number(req.params.submissionId));
    if (!ok) return res.status(409).json({ error: "item não está na fila (já rodando ou concluído)" });
    res.json({ ok: true });
});

export default router;

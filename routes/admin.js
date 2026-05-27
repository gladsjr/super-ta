// Rotas administrativas (auth via sessão, gate `requireAdmin`).
// Gerencia works (criação, listagem, orçamento), defaults expostos pro
// frontend, e CRUD básico de usuários.

import express from "express";
import { requireAdmin, sanitizeLabel } from "../lib/middleware.js";
import { listUsers, createUser, deleteUser, changeOwnPassword } from "../auth.js";
import * as db from "../lib/db.js";
import { DEFAULT_WORK_BUDGET_USD } from "../lib/config.js";
import log from "../lib/logger.js";

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

router.post("/admin/works", requireAdmin, async (req, res) => {
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
    try {
        const work = await db.createWork(name, budget);
        log.info("ADMIN", `work created token=${work.work_token} name="${work.name}" budget=$${Number(work.budget_usd).toFixed(2)} by=${req.session.user.username}`);
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
        const ok = await db.deleteWork(work.id);
        if (!ok) return res.status(404).json({ error: "work not found" });
        log.info("ADMIN", `work DELETED token=${workToken} name="${work.name}" by=${req.session.user.username}`);
        res.json({ ok: true, deleted: workToken });
    } catch (err) {
        log.error("ADMIN", `delete work failed: ${err.message}`);
        res.status(500).json({ error: "failed to delete work" });
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
        const users = await listUsers();
        res.json({ users });
    } catch (err) {
        log.error("ADMIN", `list users failed: ${err.message}`);
        res.status(500).json({ error: "failed to list users" });
    }
});

router.post("/admin/users", requireAdmin, async (req, res) => {
    try {
        const user = await createUser(req.body?.username, req.body?.password);
        log.info("ADMIN", `user created username="${user.username}" by=${req.session.user.username}`);
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

export default router;

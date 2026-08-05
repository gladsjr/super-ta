// Ativação de conta por CONVITE (público, auth pelo token de uso único).
// GET /ativar — página; GET /api/ativar?token= — valida e diz para quem é;
// POST /api/ativar {token, password} — define a senha e consome o convite.
// Ver lib/invites.js e docs/access-model.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import bcrypt from "bcrypt";
import { getActivatableInvite, activateInvite } from "../lib/invites.js";
import log from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

const router = express.Router();
const json = express.json({ limit: "8kb" });

router.get("/ativar", (_req, res) => res.sendFile(path.join(STATIC_DIR, "ativar.html")));

router.get("/api/ativar", async (req, res) => {
    try {
        const inv = await getActivatableInvite(req.query.token);
        res.json({ ok: true, name: inv.display_name || inv.username, email: inv.email });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post("/api/ativar", json, async (req, res) => {
    try {
        const { username } = await activateInvite(req.body?.token, req.body?.password, bcrypt);
        log.info("INVITE", `conta ativada: ${username}`);
        res.json({ ok: true, username });
    } catch (err) {
        if (!err.status || err.status >= 500) log.error("INVITE", `ativação falhou: ${err.message}`);
        res.status(err.status || 500).json({ error: err.message });
    }
});

export default router;

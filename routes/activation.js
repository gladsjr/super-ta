// Ativação de conta por CONVITE (público, auth pelo token de uso único).
// GET /ativar — página; GET /api/ativar?token= — valida e diz para quem é;
// POST /api/ativar {token, password} — define a senha e consome o convite.
// Ver lib/invites.js e docs/access-model.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { getActivatableInvite, activateInvite } from "../lib/invites.js";
import { AUTH_POLICY_STRICT } from "../lib/authPolicy.js";
import log from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

const router = express.Router();
const json = express.json({ limit: "8kb" });

// Proteção do endpoint público de ativação (issue #157): trava brute-force de
// token e abuso. SÓ ativo quando ENFORCE_AUTH_POLICY=true — senão o skip
// desliga o limitador (ambientes sem essa configuração seguem como antes).
const activationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !AUTH_POLICY_STRICT,
    message: { error: "Muitas tentativas. Tente de novo em alguns minutos." },
});

router.get("/ativar", (_req, res) => res.sendFile(path.join(STATIC_DIR, "ativar.html"), { headers: { "Cache-Control": "no-cache" } }));

router.get("/api/ativar", activationLimiter, async (req, res) => {
    try {
        const inv = await getActivatableInvite(req.query.token);
        res.json({ ok: true, name: inv.display_name || inv.username, email: inv.email });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post("/api/ativar", activationLimiter, json, async (req, res) => {
    try {
        const { username } = await activateInvite(req.body?.token, req.body?.password, req.body?.cpf, bcrypt);
        log.info("INVITE", `conta ativada: ${username}`);
        res.json({ ok: true, username });
    } catch (err) {
        if (!err.status || err.status >= 500) log.error("INVITE", `ativação falhou: ${err.message}`);
        res.status(err.status || 500).json({ error: err.message });
    }
});

export default router;

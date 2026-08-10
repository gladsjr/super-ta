// IdP de MENTIRA (Fase 2 do plano multi-institucional) — só em dev. Simula um
// provedor federado (o SSO de um tenant) sem servidor externo: uma telinha
// "entrar como <e-mail>" que devolve um subject e abre a sessão pelo mesmo
// caminho do SSO real (provisionFederatedUser + user_identities). Trocar o mock
// por WorkOS/OIDC/SAML real depois não muda o resto do fluxo.
//
// Guardas: só funciona fora de produção E só para provedores kind='mock'.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { pool, provisionFederatedUser } from "../auth.js";
import log from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

const router = express.Router();
const json = express.json({ limit: "8kb" });

// IdP de mentira: OFF por padrão em TODO lugar (issue #143). Só liga com a flag
// EXPLÍCITA ENABLE_MOCK_IDP=true E fora de produção. Assim staging/preview/prod
// (ou dev sem a flag) devolvem 404 — sem risco de personificação por e-mail.
const MOCK_ENABLED = process.env.ENABLE_MOCK_IDP === "true" && process.env.NODE_ENV !== "production";

async function mockProvider(key) {
    const r = await pool.query(
        `SELECT id, key, kind, name, owner_tenant_unit_id FROM auth_providers
          WHERE key = $1 AND kind = 'mock' AND is_active LIMIT 1`,
        [key]
    );
    return r.rows[0] || null;
}

// Página do IdP de mentira (dev). Query: ?next=/unidades para voltar depois.
router.get("/auth/mock/:providerKey", async (req, res) => {
    if (!MOCK_ENABLED) return res.status(404).send("not found");
    if (!(await mockProvider(req.params.providerKey))) return res.status(404).send("mock provider not found");
    res.sendFile(path.join(STATIC_DIR, "mock-login.html"));
});

// "Autentica": recebe e-mail (e nome), provisiona/associa a conta e abre sessão
// marcando o provedor mock como o usado (o filtro provedor-aceito lê isto).
router.post("/auth/mock/:providerKey", json, async (req, res) => {
    if (!MOCK_ENABLED) return res.status(404).json({ error: "not_found" });
    const prov = await mockProvider(req.params.providerKey);
    if (!prov) return res.status(404).json({ error: "mock_provider_not_found" });
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid_email" });
    try {
        const user = await provisionFederatedUser({
            provider: prov.key,
            sub: `mock:${prov.key}:${email}`,
            email,
            displayName: req.body?.name || null,
        });
        req.session.regenerate((err) => {
            if (err) { log.error("AUTH", `mock regenerate failed: ${err.message}`); return res.status(500).json({ error: "login_failed" }); }
            req.session.user = { id: user.id, username: user.username, email: user.email || null };
            req.session.authProvider = { key: prov.key, kind: "mock" }; // federado (não é realm aberto)
            req.session.save((e2) => {
                if (e2) { log.error("AUTH", `mock save failed: ${e2.message}`); return res.status(500).json({ error: "login_failed" }); }
                log.info("AUTH", `mock login provider=${prov.key} user=${user.username}`);
                res.json({ ok: true });
            });
        });
    } catch (err) {
        log.error("AUTH", `mock login failed: ${err.message}`);
        res.status(err.status || 500).json({ error: err.message });
    }
});

export default router;

// Porta da INSTITUIÇÃO (Fase 4). Duas peças públicas:
//  - GET /api/tenant/:slug  → config da porta (marca + provedores) p/ a página.
//  - GET /api/hint?email=   → a "pista": se o domínio do e-mail tem tenant,
//    devolve a slug (a porta genérica sugere isso na falha do login aberto).
// A página em si (GET /:slug) é servida por último em server.js (rota curinga).

import express from "express";
import { getTenantBySlug, tenantHintForEmail } from "../lib/tenants.js";
import log from "../lib/logger.js";

const router = express.Router();

router.get("/api/tenant/:slug", async (req, res) => {
    try {
        const t = await getTenantBySlug(req.params.slug);
        if (!t) return res.status(404).json({ error: "tenant_not_found" });
        res.json({
            slug: t.slug,
            display_name: t.display_name,
            branding: t.branding,
            providers: t.providers, // [{key, kind, name}]
        });
    } catch (err) {
        log.error("TENANT", `config failed: ${err.message}`);
        res.status(500).json({ error: "internal error" });
    }
});

router.get("/api/hint", async (req, res) => {
    try {
        const hint = await tenantHintForEmail(req.query.email);
        res.json({ tenant: hint }); // { slug, display_name } | null
    } catch {
        res.json({ tenant: null });
    }
});

export default router;

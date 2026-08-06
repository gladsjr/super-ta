// Administração de TENANTS (Fase 5) — só admin global (equipe ORATIA). Configura
// pela UI o que antes só existia via SQL/seed: a instituição-raiz vira tenant
// (slug + marca), seus domínios (a pista), seus provedores (SSO federado) e a
// política de "login aceito" por unidade. Ver docs/auth-multitenant-plan.md.

import express from "express";
import { requireAdmin } from "../lib/middleware.js";
import { pool } from "../auth.js";
import { getUnit } from "../lib/units.js";
import log from "../lib/logger.js";

const router = express.Router();
const json = express.json({ limit: "16kb" });

const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const PROV_KEY_RE = /^[a-z0-9_]{2,40}$/;
// Slugs que colidiriam com rotas reais (a curinga /:slug fica por último, mas
// não deixamos criar um tenant que nunca seria alcançável).
const RESERVED_SLUGS = new Set([
    "admin", "login", "logout", "unidades", "instituicoes", "benchmark", "cost-audit",
    "trabalho", "envio", "ativar", "scenarios", "api", "auth", "static", "s", "w", "i", "me", "diag",
]);
const CREATABLE_KINDS = new Set(["mock", "oidc", "saml"]); // federados; local/google são globais (seed)

function httpErr(res, err) {
    const status = err?.status || 500;
    if (status >= 500) log.error("TENANTS", err.message);
    return res.status(status).json({ error: err?.message || "internal error" });
}
async function assertRoot(unitId) {
    const u = await getUnit(unitId);
    if (!u) throw Object.assign(new Error("unit_not_found"), { status: 404 });
    if (u.parent_id != null) throw Object.assign(new Error("tenant_requires_root_unit"), { status: 400 });
    return u;
}

// ---- Tenant (slug + marca) --------------------------------------------------

router.get("/admin/units/:unitId/tenant", requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT unit_id, slug, display_name, branding_json FROM tenants WHERE unit_id = $1`,
            [Number(req.params.unitId)]
        );
        res.json({ tenant: r.rows[0] || null });
    } catch (err) { return httpErr(res, err); }
});

router.put("/admin/units/:unitId/tenant", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        await assertRoot(unitId);
        const slug = String(req.body?.slug || "").trim().toLowerCase();
        if (!SLUG_RE.test(slug)) throw Object.assign(new Error("invalid_slug"), { status: 400 });
        if (RESERVED_SLUGS.has(slug)) throw Object.assign(new Error("reserved_slug"), { status: 409 });
        const clash = await pool.query(`SELECT 1 FROM tenants WHERE slug = $1 AND unit_id <> $2`, [slug, unitId]);
        if (clash.rowCount) throw Object.assign(new Error("slug_taken"), { status: 409 });
        const accent = req.body?.accent ? String(req.body.accent).slice(0, 32) : null;
        const branding = accent ? { accent } : {};
        const r = await pool.query(
            `INSERT INTO tenants (unit_id, slug, display_name, branding_json)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (unit_id) DO UPDATE
               SET slug = EXCLUDED.slug, display_name = EXCLUDED.display_name, branding_json = EXCLUDED.branding_json
             RETURNING unit_id, slug, display_name, branding_json`,
            [unitId, slug, req.body?.display_name || null, JSON.stringify(branding)]
        );
        log.info("TENANTS", `tenant upsert unit=${unitId} slug=${slug} by=${req.session.user.username}`);
        res.json({ tenant: r.rows[0] });
    } catch (err) { return httpErr(res, err); }
});

router.delete("/admin/units/:unitId/tenant", requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM tenants WHERE unit_id = $1`, [Number(req.params.unitId)]);
        res.json({ ok: true });
    } catch (err) { return httpErr(res, err); }
});

// ---- Domínios (a pista) -----------------------------------------------------

router.get("/admin/units/:unitId/domains", requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT id, domain FROM auth_domains WHERE tenant_unit_id = $1 ORDER BY domain`,
            [Number(req.params.unitId)]
        );
        res.json({ domains: r.rows });
    } catch (err) { return httpErr(res, err); }
});

router.post("/admin/units/:unitId/domains", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        const domain = String(req.body?.domain || "").trim().toLowerCase();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw Object.assign(new Error("invalid_domain"), { status: 400 });
        const exists = await pool.query(`SELECT tenant_unit_id FROM auth_domains WHERE domain = $1`, [domain]);
        if (exists.rowCount) throw Object.assign(new Error("domain_taken"), { status: 409 });
        const r = await pool.query(
            `INSERT INTO auth_domains (domain, tenant_unit_id) VALUES ($1, $2) RETURNING id, domain`,
            [domain, unitId]
        );
        res.json({ domain: r.rows[0] });
    } catch (err) { return httpErr(res, err); }
});

router.delete("/admin/domains/:id", requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM auth_domains WHERE id = $1`, [Number(req.params.id)]);
        res.json({ ok: true });
    } catch (err) { return httpErr(res, err); }
});

// ---- Provedores -------------------------------------------------------------

// Catálogo: globais (local/Google) + os do tenant desta unidade.
router.get("/admin/units/:unitId/providers", requireAdmin, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        const r = await pool.query(
            `SELECT id, key, kind, name, owner_tenant_unit_id, is_active FROM auth_providers
              WHERE owner_tenant_unit_id IS NULL OR owner_tenant_unit_id = $1
              ORDER BY (owner_tenant_unit_id IS NOT NULL), name`,
            [unitId]
        );
        res.json({ providers: r.rows });
    } catch (err) { return httpErr(res, err); }
});

// Cria um provedor FEDERADO do tenant (piloto: 'mock'; oidc/saml têm schema mas
// runtime pendente). Segredos NÃO entram aqui (env/cofre).
router.post("/admin/units/:unitId/providers", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    try {
        await assertRoot(unitId);
        const kind = String(req.body?.kind || "").trim();
        if (!CREATABLE_KINDS.has(kind)) throw Object.assign(new Error("invalid_kind"), { status: 400 });
        const name = String(req.body?.name || "").trim();
        if (!name) throw Object.assign(new Error("name_required"), { status: 400 });
        let key = String(req.body?.key || "").trim().toLowerCase()
            || `${kind}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20)}_${unitId}`;
        if (!PROV_KEY_RE.test(key)) throw Object.assign(new Error("invalid_key"), { status: 400 });
        const clash = await pool.query(`SELECT 1 FROM auth_providers WHERE key = $1`, [key]);
        if (clash.rowCount) throw Object.assign(new Error("key_taken"), { status: 409 });
        const r = await pool.query(
            `INSERT INTO auth_providers (key, kind, name, owner_tenant_unit_id, is_active)
             VALUES ($1, $2, $3, $4, true) RETURNING id, key, kind, name, owner_tenant_unit_id, is_active`,
            [key, kind, name, unitId]
        );
        log.info("TENANTS", `provider created key=${key} kind=${kind} unit=${unitId} by=${req.session.user.username}`);
        res.json({ provider: r.rows[0] });
    } catch (err) { return httpErr(res, err); }
});

// Remove um provedor DO TENANT (nunca os globais). O FK de user_identities é
// ON DELETE CASCADE, então some junto — ok em dev; em prod, cuidado.
router.delete("/admin/providers/:id", requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            `DELETE FROM auth_providers WHERE id = $1 AND owner_tenant_unit_id IS NOT NULL RETURNING id`,
            [Number(req.params.id)]
        );
        if (r.rowCount === 0) throw Object.assign(new Error("not_removable"), { status: 400 });
        res.json({ ok: true });
    } catch (err) { return httpErr(res, err); }
});

// ---- Login aceito por unidade (unit_auth_policies) --------------------------

router.get("/admin/units/:unitId/accepted-providers", requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT provider_id FROM unit_auth_policies WHERE unit_id = $1`,
            [Number(req.params.unitId)]
        );
        res.json({ provider_ids: r.rows.map((x) => x.provider_id) });
    } catch (err) { return httpErr(res, err); }
});

// Substitui o conjunto aceito pela unidade. Vazio = sem política = aceita o
// realm aberto (local/Google). Atômico.
router.put("/admin/units/:unitId/accepted-providers", requireAdmin, json, async (req, res) => {
    const unitId = Number(req.params.unitId);
    const ids = Array.isArray(req.body?.provider_ids) ? req.body.provider_ids.map(Number).filter(Number.isInteger) : [];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM unit_auth_policies WHERE unit_id = $1`, [unitId]);
        for (const pid of ids) {
            await client.query(
                `INSERT INTO unit_auth_policies (unit_id, provider_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [unitId, pid]
            );
        }
        await client.query("COMMIT");
        res.json({ provider_ids: ids });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        return httpErr(res, err);
    } finally {
        client.release();
    }
});

export default router;

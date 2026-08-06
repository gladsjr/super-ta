// Tenants, domínios (a "pista") e a política de provedores por unidade
// (migration 069 + unit_auth_policies da 066). Ver docs/auth-multitenant-plan.md.

import { pool } from "../auth.js";

// Provedores considerados "realm aberto" (não federados). Um provedor aberto é
// aceito por qualquer unidade que NÃO tenha política explícita.
export const OPEN_PROVIDER_KINDS = new Set(["local", "google"]);

// Config pública de um tenant pela slug (para a porta /:slug). Retorna null se
// não existir. Providers = os provedores ATIVOS do tenant (federados) + os
// abertos, na ordem federado→aberto (o SSO é o caminho principal).
export async function getTenantBySlug(slug) {
    const t = await pool.query(
        `SELECT unit_id, slug, display_name, branding_json FROM tenants WHERE slug = $1`,
        [String(slug || "").toLowerCase()]
    );
    if (t.rowCount === 0) return null;
    const tenant = t.rows[0];
    // Provedores da porta = os que o tenant ACEITA: os federados que ele possui
    // + os explicitamente listados na política da unidade-raiz (ex.: 'local' como
    // contingência, se a instituição quiser). SSO-only mostra só o SSO.
    const provs = await pool.query(
        `SELECT DISTINCT pr.key, pr.kind, pr.name FROM auth_providers pr
          WHERE pr.is_active AND (
                pr.owner_tenant_unit_id = $1
             OR pr.id IN (SELECT provider_id FROM unit_auth_policies WHERE unit_id = $1))
          ORDER BY pr.name`,
        [tenant.unit_id]
    );
    return {
        slug: tenant.slug,
        unit_id: tenant.unit_id,
        display_name: tenant.display_name,
        branding: tenant.branding_json || {},
        providers: provs.rows,
    };
}

// A PISTA: dado um e-mail, devolve a slug do tenant associado ao seu domínio, ou
// null. Usado só para SUGERIR a porta do tenant na falha do login aberto.
export async function tenantHintForEmail(email) {
    const at = String(email || "").toLowerCase().split("@")[1];
    if (!at) return null;
    const r = await pool.query(
        `SELECT t.slug, t.display_name FROM auth_domains d
           JOIN tenants t ON t.unit_id = d.tenant_unit_id
          WHERE d.domain = $1 LIMIT 1`,
        [at]
    );
    return r.rows[0] || null;
}

// Mapa unidade → Set(keys de provedor aceitos), a partir de unit_auth_policies.
// Unidade AUSENTE do mapa = sem política = aceita o realm aberto (default).
export async function acceptedProviderMap() {
    const r = await pool.query(
        `SELECT p.unit_id, pr.key FROM unit_auth_policies p
           JOIN auth_providers pr ON pr.id = p.provider_id`
    );
    const map = new Map();
    for (const row of r.rows) {
        if (!map.has(row.unit_id)) map.set(row.unit_id, new Set());
        map.get(row.unit_id).add(row.key);
    }
    return map;
}

// A unidade aceita o provedor usado no login? Sem política → aceita se o provedor
// for do realm aberto (local/Google). Com política → só os provedores listados.
export function unitAcceptsProvider(map, unitId, providerKey, providerKind) {
    const policy = map.get(unitId);
    if (!policy) return OPEN_PROVIDER_KINDS.has(providerKind || "");
    return policy.has(providerKey);
}

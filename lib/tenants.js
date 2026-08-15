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
    // Só provedores com HANDLER de login funcional (#149): sem isto, a porta
    // anunciaria oidc/saml (schema pronto, runtime ausente) e o login seria
    // impossível ao clicar. Os kinds com runtime são local/google/mock.
    const provs = await pool.query(
        `SELECT DISTINCT pr.key, pr.kind, pr.name FROM auth_providers pr
          WHERE pr.is_active
            AND pr.kind IN ('local', 'google', 'mock')
            AND (
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

// Carrega a política de auth para resolução COM HERANÇA (#160): o mapa de políticas
// por unidade (a partir de unit_auth_policies) + o mapa de parent_id (para subir a
// árvore). A política EFETIVA de uma unidade é a do ancestral mais próximo que tenha
// política PRÓPRIA; sem nenhum ancestral com política, vale o realm aberto (default).
export async function loadAuthPolicy() {
    const [pol, tree] = await Promise.all([
        pool.query(`SELECT p.unit_id, pr.key FROM unit_auth_policies p
                      JOIN auth_providers pr ON pr.id = p.provider_id`),
        pool.query(`SELECT id, parent_id FROM units`),
    ]);
    const policy = new Map();
    for (const row of pol.rows) {
        if (!policy.has(row.unit_id)) policy.set(row.unit_id, new Set());
        policy.get(row.unit_id).add(row.key);
    }
    const parent = new Map();
    for (const row of tree.rows) parent.set(row.id, row.parent_id);
    return { policy, parent };
}

// A unidade aceita o provedor usado no login? Resolve a política EFETIVA subindo a
// árvore até o PRIMEIRO ancestral (a própria unidade primeiro) com política PRÓPRIA
// (#160): a raiz SSO-only protege toda a sua sub-árvore. Uma política própria numa
// filha é o "override" — inclusive para REABRIR (basta listar local/google nela).
// Sem nenhum ancestral com política → realm aberto (local/Google), o default.
export function unitAcceptsProvider(authPolicy, unitId, providerKey, providerKind) {
    const { policy, parent } = authPolicy || {};
    if (!policy) return OPEN_PROVIDER_KINDS.has(providerKind || ""); // defensivo
    let cur = unitId, guard = 0;
    while (cur != null && guard++ < 64) {
        const p = policy.get(cur);
        if (p) return p.has(providerKey);      // 1º ancestral com política própria vence
        cur = parent.get(cur);
    }
    return OPEN_PROVIDER_KINDS.has(providerKind || "");
}

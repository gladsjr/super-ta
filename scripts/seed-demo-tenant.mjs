// Seed de um TENANT de demonstração para testar as duas portas (Fase 4) — só dev.
// Cria: instituição "Instituto Demo" (slug 'demo'), uma turma que aceita só o
// provedor federado de mentira, o provedor mock, o domínio demo.edu (a pista) e
// um aluno (aluno@demo.edu) já vinculado. Idempotente. Rodar:
//   node -r dotenv/config scripts/seed-demo-tenant.mjs
import { pool } from "../auth.js";

async function upsertUnit(name, parentId, isClass) {
    const ex = await pool.query(`SELECT id FROM units WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2`, [name, parentId]);
    if (ex.rowCount) { await pool.query(`UPDATE units SET is_class=$2 WHERE id=$1`, [ex.rows[0].id, isClass]); return ex.rows[0].id; }
    const r = await pool.query(
        `INSERT INTO units (parent_id, name, label, is_class, source) VALUES ($1,$2,$3,$4,'manual') RETURNING id`,
        [parentId, name, isClass ? "turma" : "instituição", isClass]
    );
    return r.rows[0].id;
}

async function main() {
    const root = await upsertUnit("Instituto Demo", null, false);
    const turma = await upsertUnit("Turma Demo 2026", root, true);

    // Tenant (slug + marca)
    await pool.query(
        `INSERT INTO tenants (unit_id, slug, display_name, branding_json)
         VALUES ($1,'demo','Instituto Demo', '{"accent":"#7c3aed"}'::jsonb)
         ON CONFLICT (unit_id) DO UPDATE SET slug=EXCLUDED.slug, display_name=EXCLUDED.display_name, branding_json=EXCLUDED.branding_json`,
        [root]
    );

    // Provedor federado de MENTIRA, dono = o tenant
    const prov = await pool.query(
        `INSERT INTO auth_providers (key, kind, name, owner_tenant_unit_id, is_active)
         VALUES ('demo_sso','mock','SSO do Instituto Demo',$1,true)
         ON CONFLICT (key) DO UPDATE SET owner_tenant_unit_id=$1, is_active=true
         RETURNING id`,
        [root]
    );
    const provId = prov.rows[0].id;

    // Domínio associado (a pista) e política: a turma SÓ aceita o SSO demo
    await pool.query(
        `INSERT INTO auth_domains (domain, tenant_unit_id) VALUES ('demo.edu',$1)
         ON CONFLICT (domain) DO UPDATE SET tenant_unit_id=$1`,
        [root]
    );
    for (const unitId of [root, turma]) {
        await pool.query(
            `INSERT INTO unit_auth_policies (unit_id, provider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [unitId, provId]
        );
    }

    // Aluno demo já vinculado à turma (o mock, ao entrar com este e-mail, casa
    // por e-mail e vê a turma). Sem senha — entra pelo SSO de mentira.
    let user = (await pool.query(`SELECT id FROM users WHERE lower(email)='aluno@demo.edu'`)).rows[0];
    if (!user) {
        user = (await pool.query(
            `INSERT INTO users (username, email, display_name, source) VALUES ('aluno_demo','aluno@demo.edu','Aluno Demo','manual') RETURNING id`
        )).rows[0];
    }
    const alunoRole = (await pool.query(`SELECT id FROM roles WHERE key='aluno'`)).rows[0].id;
    await pool.query(
        `INSERT INTO memberships (user_id, unit_id, role_id, source) VALUES ($1,$2,$3,'manual') ON CONFLICT DO NOTHING`,
        [user.id, turma, alunoRole]
    );

    console.log(`✓ tenant demo pronto: /demo  (turma #${turma}, aluno@demo.edu)`);
    await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

// Convites de ativação de conta (migration 067) — o caminho de entrada de
// professores e alunos no piloto institucional. Ver docs/access-model.md.
//
// Fluxo: admin cria a PESSOA (nome + e-mail, sem senha) já vinculada a uma
// unidade num papel → nasce um convite (token de uso único, expira) → a pessoa
// abre /ativar?token=... e escolhe a senha. Reenviar invalida o link anterior.
//
// v1 sem servidor de e-mail: buildInviteEmailsText gera o texto dos e-mails
// que SERIAM enviados (download TXT no painel); o envio é ação explícita do
// admin, nunca consequência escondida.

import crypto from "node:crypto";
import { pool } from "../auth.js";
import { addMembership } from "./rbac.js";
import { isValidCpf } from "./cpf.js";
import { findOrCreatePersonByCpf, linkUserToPerson } from "./persons.js";

const INVITE_TTL_DAYS = 14;

// Guarda-se apenas o HASH do token (issue #156) — o token cru só existe no
// instante da emissão. sha256 hex, a MESMA função do backfill da migration 072.
function hashToken(raw) {
    return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function inviteState(row) {
    if (row.used_at) return "ativado";
    if (row.canceled_at) return "cancelado";
    if (new Date(row.expires_at).getTime() < Date.now()) return "expirado";
    return "pendente";
}

// Cria (ou reaproveita) a PESSOA por e-mail e a vincula à unidade no papel.
// Se a conta ainda não tem como entrar (sem senha e sem identidade SSO), gera
// convite — cancelando pendentes anteriores. Retorna { user, membership, invite }.
export async function createPersonWithInvite({ name, email, role, unitId, createdByUserId = null }) {
    const em = String(email ?? "").trim().toLowerCase();
    const nm = String(name ?? "").trim();
    if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
        throw Object.assign(new Error("invalid_email"), { status: 400 });
    }
    if (!nm) throw Object.assign(new Error("name_required"), { status: 400 });

    // Conta-de-e-mail única por e-mail: reaproveita se já existe (não duplica).
    // O CPF/pessoa NÃO entra aqui — vem quando o convidado aceita (activateInvite).
    let user = (await pool.query(`SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`, [em])).rows[0] || null;
    if (!user) {
        const base = em.split("@")[0].replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24) || "pessoa";
        let candidate = base, n = 1;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const clash = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [candidate]);
            if (clash.rowCount === 0) break;
            candidate = `${base}_${n++}`;
        }
        user = (await pool.query(
            `INSERT INTO users (username, email, display_name, source)
             VALUES ($1, $2, $3, 'manual') RETURNING *`,
            [candidate, em, nm]
        )).rows[0];
    }

    const membership = await addMembership({ userId: user.id, unitId, role });

    // Convite só se a conta ainda não tem porta de entrada.
    let invite = null;
    const hasIdentity = (await pool.query(`SELECT 1 FROM user_identities WHERE user_id = $1 LIMIT 1`, [user.id])).rowCount > 0;
    if (!user.password_hash && !hasIdentity) {
        invite = await issueInvite({ userId: user.id, email: em, createdByUserId });
    }
    return { user, membership, invite };
}

// Emite um convite novo, cancelando os pendentes do mesmo usuário (reenvio
// invalida o link anterior — regra da spec).
export async function issueInvite({ userId, email = null, createdByUserId = null }) {
    const em = email || (await pool.query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0]?.email;
    if (!em) throw Object.assign(new Error("user_has_no_email"), { status: 400 });
    await pool.query(
        `UPDATE invites SET canceled_at = now()
          WHERE user_id = $1 AND used_at IS NULL AND canceled_at IS NULL`,
        [userId]
    );
    const token = crypto.randomBytes(24).toString("base64url");
    const r = await pool.query(
        `INSERT INTO invites (user_id, email, token_hash, created_by_user_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '${INVITE_TTL_DAYS} days')
         RETURNING id, user_id, email, created_at, expires_at, used_at, canceled_at`,
        [userId, em, hashToken(token), createdByUserId]
    );
    // token CRU devolvido só aqui (uma vez) para montar o link; NÃO é persistido.
    return { ...r.rows[0], token, state: "pendente" };
}

// unitId escopa o cancelamento à unidade da rota: o convite só é cancelado se o
// seu usuário for MEMBRO dessa unidade (invites não têm unit_id — o vínculo com a
// unidade é via o user). Sem isso, um admin da unidade A cancelaria convite de
// alguém fora do seu escopo com um inviteId qualquer (IDOR horizontal, issue #141).
export async function cancelInvite(inviteId, unitId) {
    const r = await pool.query(
        `UPDATE invites SET canceled_at = now()
          WHERE id = $1 AND used_at IS NULL AND canceled_at IS NULL
            AND user_id IN (SELECT user_id FROM memberships WHERE unit_id = $2)
          RETURNING id`,
        [inviteId, unitId]
    );
    if (r.rowCount === 0) throw Object.assign(new Error("invite_not_pending"), { status: 409 });
    return r.rows[0];
}

// Convites das pessoas VINCULADAS à unidade (qualquer papel), mais recente de
// cada pessoa primeiro — alimenta a lista de estado no painel.
export async function listUnitInvites(unitId) {
    const r = await pool.query(
        `SELECT DISTINCT ON (i.user_id) i.id, i.user_id, i.email,
                i.created_at, i.expires_at, i.used_at, i.canceled_at,
                u.display_name, u.username
           FROM invites i
           JOIN users u ON u.id = i.user_id
          WHERE i.user_id IN (SELECT user_id FROM memberships WHERE unit_id = $1)
          ORDER BY i.user_id, i.created_at DESC`,
        [unitId]
    );
    return r.rows.map((row) => ({ ...row, state: inviteState(row) }));
}

// Valida um token de ativação. Retorna a linha do convite ou lança com motivo.
export async function getActivatableInvite(token) {
    const r = await pool.query(
        `SELECT i.*, u.display_name, u.username FROM invites i JOIN users u ON u.id = i.user_id
          WHERE i.token_hash = $1 LIMIT 1`,
        [hashToken(token)]
    );
    const inv = r.rows[0];
    if (!inv) throw Object.assign(new Error("invite_not_found"), { status: 404 });
    const state = inviteState(inv);
    if (state !== "pendente") throw Object.assign(new Error(`invite_${state}`), { status: 410 });
    return inv;
}

// Ativa a conta: define a senha, captura o CPF (find-or-create da PESSOA e
// ligação da conta) e consome o convite. Atômico. O CPF é obrigatório aqui — é o
// momento em que o convidado ACEITA o vínculo (docs/auth-multitenant-plan.md).
export async function activateInvite(token, password, cpf, bcrypt) {
    if (String(password ?? "").length < 6) {
        throw Object.assign(new Error("password_too_short"), { status: 400 });
    }
    if (!isValidCpf(cpf)) throw Object.assign(new Error("invalid_cpf"), { status: 400 });
    const inv = await getActivatableInvite(token);
    const hash = await bcrypt.hash(String(password), 12);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const used = await client.query(
            `UPDATE invites SET used_at = now()
              WHERE id = $1 AND used_at IS NULL AND canceled_at IS NULL RETURNING id`,
            [inv.id]
        );
        if (used.rowCount === 0) throw Object.assign(new Error("invite_already_used"), { status: 410 });
        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, inv.user_id]);
        // Pessoa por CPF: agrega e-mails do mesmo humano (mesmo CPF → mesma pessoa).
        const person = await findOrCreatePersonByCpf(
            { cpf, displayName: inv.display_name || null }, client
        );
        await linkUserToPerson(inv.user_id, person.id, client);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return { userId: inv.user_id, username: inv.username };
}

// v1 sem e-mail: o texto dos e-mails que SERIAM enviados (um bloco por convite
// pendente), pronto para download/copiar. baseUrl ex.: https://oratia.app
export function buildInviteEmailsText(invites, baseUrl) {
    const pending = invites.filter((i) => i.state === "pendente");
    if (!pending.length) return "Nenhum convite pendente.\n";
    const blocks = pending.map((i) => {
        const link = `${baseUrl}/ativar?token=${i.token}`;
        const nome = i.display_name || i.username || i.email;
        return [
            `Para: ${i.email}`,
            `Assunto: Convite ORATIA — ative sua conta`,
            ``,
            `Olá, ${nome}!`,
            ``,
            `Você foi convidado(a) para o ORATIA. Para ativar sua conta e`,
            `escolher sua senha, acesse o link abaixo (válido até ${new Date(i.expires_at).toLocaleDateString("pt-BR")}):`,
            ``,
            `${link}`,
            ``,
            `Se você não esperava este convite, ignore este e-mail.`,
        ].join("\n");
    });
    return blocks.join("\n\n----------------------------------------\n\n") + "\n";
}

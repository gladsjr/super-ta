import bcrypt from "bcrypt";
import pg from "pg";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import log from "./lib/logger.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// keepAlive mantém o TCP das conexões vivo, reduzindo a chance de o banco/rede
// derrubar conexões ociosas durante operações longas (ex.: avaliação ~72s).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
});

// node-postgres: um cliente OCIOSO do pool continua ligado a um backend vivo e
// pode emitir 'error' se a conexão cair (timeout do banco, blip de rede,
// reciclagem). Sem este listener, esse 'error' vira "unhandled 'error' event" e
// DERRUBA o processo inteiro (exit status 1). O pool já descarta o cliente
// quebrado sozinho — aqui só registramos, sem relançar.
pool.on("error", (err) => {
  log.error("DB", `pool idle client error: ${err.message}`);
});

const PgSession = connectPgSimple(session);

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

export const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "app_session",
    createTableIfMissing: false,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

export async function seedInitialUsers() {
  const raw = process.env.INITIAL_USERS;
  if (!raw) {
    console.warn("⚠️  INITIAL_USERS não definido — nenhum usuário criado");
    return;
  }

  const pairs = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    if (idx < 1) {
      console.warn(`⚠️  Formato inválido em INITIAL_USERS: "${pair}"`);
      continue;
    }
    const username = pair.slice(0, idx).trim();
    const password = pair.slice(idx + 1);

    const exists = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    if (exists.rowCount > 0) continue;

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
      [username, hash]
    );
    console.log(`✓ Usuário inicial criado: ${username}`);
  }
}

// Sincroniza a tabela `roles` a partir de ROLE_DEFS (lib/rbac.js) — padrão de
// enumeração por tabela+FK: o código referencia a `key`, o banco o role_id.
// Idempotente; roda ANTES de seedBootstrapAdmin (que precisa das linhas).
// Papéis removidos de ROLE_DEFS não são apagados às cegas: o FK RESTRICT de
// memberships acusa se houver vínculo pendurado.
export async function seedRoles() {
  const { ROLE_DEFS } = await import("./lib/rbac.js");
  for (const def of ROLE_DEFS) {
    await pool.query(
      `INSERT INTO roles (key, name) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
       WHERE roles.name IS DISTINCT FROM EXCLUDED.name`,
      [def.key, def.name]
    );
  }
  const keys = ROLE_DEFS.map((d) => d.key);
  const stale = await pool.query(
    `DELETE FROM roles WHERE key <> ALL($1::text[]) RETURNING key`,
    [keys]
  );
  for (const row of stale.rows) console.log(`✗ Papel removido: ${row.key}`);
}

// Tipos de identificador civil (migration 068) — padrão enum-por-tabela. Piloto
// só tem 'cpf'; estrangeiro entra depois como novo tipo. Idempotente.
export async function seedCivilIdTypes() {
  const base = [{ key: "cpf", name: "CPF" }];
  for (const t of base) {
    await pool.query(
      `INSERT INTO civil_id_types (key, name) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name]
    );
  }
}

// Provedores de autenticação BASE (instâncias configuradas — migration 066).
// 'local' sempre existe; 'google' existe para ancorar identidades e política
// por unidade (segredos ficam no env: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET —
// a linha só registra a instância). Provedores institucionais (oidc/saml de um
// cliente) serão criados por admin, não por seed.
export async function seedAuthProviders() {
  const base = [
    { key: "local", kind: "local", name: "E-mail e senha" },
    { key: "google", kind: "google", name: "Google" },
  ];
  for (const p of base) {
    await pool.query(
      `INSERT INTO auth_providers (key, kind, name) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [p.key, p.kind, p.name]
    );
  }
}

// Garante ao menos um admin_global (unit_id NULL) para o sistema não ficar sem
// administrador da camada institucional. Idempotente. Alvo: BOOTSTRAP_ADMIN
// (username/email) ou, na falta, o primeiro usuário. Requer as migrations
// 055–066 aplicadas; se ainda não estiverem, sai quieto (dev antes do db:migrate).
export async function seedBootstrapAdmin() {
  try {
    const has = await pool.query(
      `SELECT 1 FROM memberships m JOIN roles r ON r.id = m.role_id
        WHERE r.key = 'admin_global' AND m.unit_id IS NULL LIMIT 1`
    );
    if (has.rowCount > 0) return;
    const wanted = process.env.BOOTSTRAP_ADMIN;
    let target = null;
    if (wanted) {
      target = await pool.query(
        `SELECT id, username FROM users WHERE username = $1 OR lower(email) = lower($1) LIMIT 1`,
        [wanted]
      );
    }
    if (!target || target.rowCount === 0) {
      target = await pool.query(`SELECT id, username FROM users ORDER BY id ASC LIMIT 1`);
    }
    if (target.rowCount === 0) return; // sem usuários ainda
    const u = target.rows[0];
    await pool.query(
      `INSERT INTO memberships (user_id, unit_id, role_id, source)
       SELECT $1, NULL, r.id, 'manual' FROM roles r WHERE r.key = 'admin_global'
       ON CONFLICT DO NOTHING`,
      [u.id]
    );
    console.log(`✓ admin_global bootstrap: ${u.username}`);
  } catch (err) {
    if (/relation .*(memberships|roles).* does not exist/i.test(err.message)) return;
    console.warn(`⚠️  seedBootstrapAdmin: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Bootstrap interviewer templates from config/interviewers/*.yaml.
// Filesystem is the source of truth — cada boot ressincroniza o banco:
// arquivos novos viram linhas, arquivos alterados sobrescrevem a linha,
// arquivos removidos somem do banco. Não há editor de templates na UI:
// o YAML que o professor customiza vive em works.interviewer_yaml.
// ---------------------------------------------------------------------
const INTERVIEWERS_DIR = path.join(__dirname, "config", "interviewers");

export async function seedInterviewerTemplates() {
  if (!fs.existsSync(INTERVIEWERS_DIR)) {
    console.warn(`⚠️  Diretório de templates não encontrado: ${INTERVIEWERS_DIR}`);
    return;
  }

  const entries = fs.readdirSync(INTERVIEWERS_DIR).filter((f) => /\.ya?ml$/i.test(f));
  if (entries.length === 0) {
    console.warn("⚠️  Nenhum template encontrado em config/interviewers/");
    return;
  }

  for (const filename of entries) {
    const yamlText = fs.readFileSync(path.join(INTERVIEWERS_DIR, filename), "utf8");
    const r = await pool.query(
      `INSERT INTO interviewer_templates (filename, yaml_text)
       VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE
         SET yaml_text = EXCLUDED.yaml_text
         WHERE interviewer_templates.yaml_text IS DISTINCT FROM EXCLUDED.yaml_text
       RETURNING (xmax = 0) AS inserted`,
      [filename, yamlText]
    );
    if (r.rowCount === 0) {
      console.log(`• Template inalterado: ${filename}`);
    } else if (r.rows[0].inserted) {
      console.log(`✓ Template criado: ${filename}`);
    } else {
      console.log(`↻ Template sincronizado a partir do filesystem: ${filename}`);
    }
  }

  const deleted = await pool.query(
    `DELETE FROM interviewer_templates
     WHERE filename <> ALL($1::text[])
     RETURNING filename`,
    [entries]
  );
  for (const row of deleted.rows) {
    console.log(`✗ Template removido do banco (não existe mais no filesystem): ${row.filename}`);
  }
}

// ---------------------------------------------------------------------
// Bootstrap package templates from config/packages/*.yaml. Mesmo padrão de
// seedInterviewerTemplates(): filesystem é a fonte da verdade; cada boot
// ressincroniza. loadPackageTemplates() valida+expande (fail-fast se um YAML
// for inválido). Import dinâmico evita ciclo com lib/packages.js (que importa
// `pool` daqui).
// ---------------------------------------------------------------------
export async function seedPackageTemplates() {
  const { loadPackageTemplates } = await import("./lib/packages.js");
  const templates = loadPackageTemplates(); // lança se inválido
  if (templates.length === 0) {
    console.warn("⚠️  Nenhum pacote encontrado em config/packages/");
    return;
  }
  for (const t of templates) {
    const r = await pool.query(
      `INSERT INTO package_templates (key, version, name, yaml_text, spec_json)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE
         SET version = EXCLUDED.version, name = EXCLUDED.name,
             yaml_text = EXCLUDED.yaml_text, spec_json = EXCLUDED.spec_json,
             updated_at = now()
         WHERE package_templates.yaml_text IS DISTINCT FROM EXCLUDED.yaml_text
         RETURNING (xmax = 0) AS inserted`,
      [t.key, t.version, t.name, t.yamlText, JSON.stringify(t.spec)]
    );
    if (r.rowCount === 0) console.log(`• Pacote inalterado: ${t.key}`);
    else if (r.rows[0].inserted) console.log(`✓ Pacote criado: ${t.key}`);
    else console.log(`↻ Pacote sincronizado a partir do filesystem: ${t.key}`);
  }
  const keys = templates.map((t) => t.key);
  const deleted = await pool.query(
    `DELETE FROM package_templates WHERE key <> ALL($1::text[]) RETURNING key`,
    [keys]
  );
  for (const row of deleted.rows) {
    console.log(`✗ Pacote removido do banco (não existe mais no filesystem): ${row.key}`);
  }
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

export async function loginHandler(req, res) {
  const body = req.body || {};
  // Aceita `login` (novo), `username` (legado) ou `email` como identificador.
  const login = body.login ?? body.username ?? body.email;
  const password = body.password;
  if (!login || !password) {
    return res.status(400).json({ error: "missing credentials" });
  }
  try {
    const r = await pool.query(
      "SELECT id, username, email, password_hash FROM users WHERE lower(email) = lower($1) OR username = $1 LIMIT 1",
      [login]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const user = r.rows[0];
    // Conta SSO-only (sem senha local) não faz login por senha.
    if (!user.password_hash) return res.status(401).json({ error: "invalid credentials" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    // Prevent session fixation: regenerate session ID on login
    req.session.regenerate((err) => {
      if (err) {
        console.error("Erro ao regenerar sessão:", err);
        return res.status(500).json({ error: "login failed" });
      }
      req.session.user = { id: user.id, username: user.username, email: user.email || null };
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("Erro ao salvar sessão:", saveErr);
          return res.status(500).json({ error: "login failed" });
        }
        res.json({ ok: true, user: req.session.user });
      });
    });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ error: "login failed" });
  }
}

export function logoutHandler(req, res) {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
}

// Além do usuário da sessão, informa se é admin_global — o frontend decide a
// aterrissagem (/admin p/ equipe; /unidades p/ admin de unidade, professor e
// aluno). Tolerante a schema antigo (sem as tabelas da camada institucional).
export async function meHandler(req, res) {
  if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
  let isGlobal = false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM memberships m JOIN roles ro ON ro.id = m.role_id
        WHERE m.user_id = $1 AND m.unit_id IS NULL AND ro.key = 'admin_global' LIMIT 1`,
      [req.session.user.id]
    );
    isGlobal = r.rowCount > 0;
  } catch (err) {
    if (/relation .*(memberships|roles).* does not exist/i.test(err.message)) isGlobal = true; // legado
    else console.error("meHandler:", err.message);
  }
  res.json({ user: req.session.user, is_global_admin: isGlobal });
}

// ---------------------------------------------------------------------
// User management — every authenticated user is an admin in this system.
// "Create user" === "create admin".
// ---------------------------------------------------------------------

const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
const MIN_PASSWORD_LEN = 6;

export async function listUsers() {
  const r = await pool.query(
    "SELECT id, username, email, display_name, created_at FROM users ORDER BY created_at ASC, id ASC"
  );
  return r.rows;
}

// Resolve um usuário por e-mail (case-insensitive) OU username. Usado para
// vincular papéis (memberships) por identificador amigável.
export async function getUserByLogin(login) {
  const l = String(login ?? "").trim();
  if (!l) return null;
  const r = await pool.query(
    `SELECT id, username, email, display_name FROM users
      WHERE lower(email) = lower($1) OR username = $1 LIMIT 1`,
    [l]
  );
  return r.rows[0] || null;
}

export async function createUser(username, password, opts = {}) {
  const u = String(username ?? "").trim();
  const p = String(password ?? "");
  if (!USERNAME_RE.test(u)) {
    throw Object.assign(new Error("invalid_username"), { status: 400 });
  }
  if (p.length < MIN_PASSWORD_LEN) {
    throw Object.assign(new Error("password_too_short"), { status: 400 });
  }
  const email = opts.email ? String(opts.email).trim() : null;
  const displayName = opts.displayName ? String(opts.displayName).trim() : null;
  const exists = await pool.query("SELECT id FROM users WHERE username = $1", [u]);
  if (exists.rowCount > 0) {
    throw Object.assign(new Error("username_taken"), { status: 409 });
  }
  if (email) {
    const eExists = await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
    if (eExists.rowCount > 0) throw Object.assign(new Error("email_taken"), { status: 409 });
  }
  const hash = await bcrypt.hash(p, 12);
  const r = await pool.query(
    "INSERT INTO users (username, password_hash, email, display_name, source) VALUES ($1, $2, $3, $4, 'manual') RETURNING id, username, email, display_name, created_at",
    [u, hash, email, displayName]
  );
  return r.rows[0];
}

// Provisiona/associa um usuário a partir de um login FEDERADO. `provider` é a
// KEY de uma instância em auth_providers ('google' hoje; um 'saml_campusX'
// amanhã). Ordem de resolução: (1) identidade já vinculada (user_identities)
// → (2) e-mail verificado (vincula a identidade à conta existente) → (3) cria
// conta SSO-only (sem senha). Nenhum provedor é cravado no schema de users;
// external_id_map fica para identificadores ACADÊMICOS (RA), não de login.
export async function provisionFederatedUser({ provider = "google", sub, email = null, displayName = null }) {
  if (!sub) throw Object.assign(new Error("federated_sub_required"), { status: 400 });
  const prov = await pool.query(
    `SELECT id FROM auth_providers WHERE key = $1 AND is_active LIMIT 1`,
    [provider]
  );
  if (prov.rowCount === 0) throw Object.assign(new Error(`unknown_auth_provider: ${provider}`), { status: 400 });
  const providerId = prov.rows[0].id;

  // (1) identidade já vinculada
  const known = await pool.query(
    `SELECT u.* FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider_id = $1 AND i.subject = $2 LIMIT 1`,
    [providerId, sub]
  );
  if (known.rowCount > 0) return known.rows[0];

  // (2) e-mail verificado → vincula identidade à conta existente
  let user = null;
  if (email) {
    const byEmail = await pool.query("SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1", [email]);
    if (byEmail.rowCount > 0) user = byEmail.rows[0];
  }

  // (3) cria SSO-only
  if (!user) {
    // username único derivado do e-mail/sub; sem senha (source='synced').
    const base = (email ? email.split("@")[0] : `${provider}_${sub}`).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24) || "user";
    let candidate = base, n = 1;
    // colisão rara: sufixa até achar livre
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const clash = await pool.query("SELECT 1 FROM users WHERE username = $1", [candidate]);
      if (clash.rowCount === 0) break;
      candidate = `${base}_${n++}`;
    }
    const ins = await pool.query(
      `INSERT INTO users (username, email, display_name, source)
       VALUES ($1, $2, $3, 'synced') RETURNING *`,
      [candidate, email, displayName]
    );
    user = ins.rows[0];
  }

  await pool.query(
    `INSERT INTO user_identities (user_id, provider_id, subject)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [user.id, providerId, sub]
  );
  return user;
}

// Lets a logged-in user change their own password. Verifies the current
// password before swapping the hash. Does not touch the session.
export async function changeOwnPassword(userId, currentPassword, newPassword) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) {
    throw Object.assign(new Error("invalid_id"), { status: 400 });
  }
  if (String(newPassword ?? "").length < MIN_PASSWORD_LEN) {
    throw Object.assign(new Error("password_too_short"), { status: 400 });
  }
  const r = await pool.query("SELECT password_hash FROM users WHERE id = $1", [id]);
  if (r.rowCount === 0) {
    throw Object.assign(new Error("not_found"), { status: 404 });
  }
  const ok = await bcrypt.compare(String(currentPassword ?? ""), r.rows[0].password_hash);
  if (!ok) {
    throw Object.assign(new Error("invalid_current_password"), { status: 401 });
  }
  const hash = await bcrypt.hash(String(newPassword), 12);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, id]);
}

// Returns the deleted row's username, or throws an error with .status set.
// Refuses to delete the last remaining user (would lock everyone out).
export async function deleteUser(targetId, requesterId) {
  const id = Number(targetId);
  if (!Number.isInteger(id) || id < 1) {
    throw Object.assign(new Error("invalid_id"), { status: 400 });
  }
  if (id === Number(requesterId)) {
    throw Object.assign(new Error("cannot_delete_self"), { status: 400 });
  }
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM users");
  if ((count.rows[0]?.n ?? 0) <= 1) {
    throw Object.assign(new Error("cannot_delete_last_user"), { status: 400 });
  }
  const r = await pool.query(
    "DELETE FROM users WHERE id = $1 RETURNING username",
    [id]
  );
  if (r.rowCount === 0) {
    throw Object.assign(new Error("not_found"), { status: 404 });
  }
  return r.rows[0].username;
}

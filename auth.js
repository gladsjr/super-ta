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

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

export async function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "missing credentials" });
  }
  try {
    const r = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE username = $1",
      [username]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    // Prevent session fixation: regenerate session ID on login
    req.session.regenerate((err) => {
      if (err) {
        console.error("Erro ao regenerar sessão:", err);
        return res.status(500).json({ error: "login failed" });
      }
      req.session.user = { id: user.id, username: user.username };
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

export function meHandler(req, res) {
  if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
  res.json({ user: req.session.user });
}

// ---------------------------------------------------------------------
// User management — every authenticated user is an admin in this system.
// "Create user" === "create admin".
// ---------------------------------------------------------------------

const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
const MIN_PASSWORD_LEN = 6;

export async function listUsers() {
  const r = await pool.query(
    "SELECT id, username, created_at FROM users ORDER BY created_at ASC, id ASC"
  );
  return r.rows;
}

export async function createUser(username, password) {
  const u = String(username ?? "").trim();
  const p = String(password ?? "");
  if (!USERNAME_RE.test(u)) {
    throw Object.assign(new Error("invalid_username"), { status: 400 });
  }
  if (p.length < MIN_PASSWORD_LEN) {
    throw Object.assign(new Error("password_too_short"), { status: 400 });
  }
  const exists = await pool.query("SELECT id FROM users WHERE username = $1", [u]);
  if (exists.rowCount > 0) {
    throw Object.assign(new Error("username_taken"), { status: 409 });
  }
  const hash = await bcrypt.hash(p, 12);
  const r = await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at",
    [u, hash]
  );
  return r.rows[0];
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

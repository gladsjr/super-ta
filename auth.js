import bcrypt from "bcrypt";
import pg from "pg";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import crypto from "crypto";

const { Pool } = pg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

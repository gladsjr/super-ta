import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// memória volátil por sessão (MVP sem DB)
const SESSIONS = new Map();

// static
app.use("/static", express.static(path.join(__dirname, "static")));
app.use(express.json({ limit: "2mb" }));

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = "gpt-4o-mini";

// helpers
function loadConfigs() {
  const cfgDir = path.join(__dirname, "config");
  const assignment = JSON.parse(fs.readFileSync(path.join(cfgDir, "assignment.json"), "utf-8"));
  const rubric = JSON.parse(fs.readFileSync(path.join(cfgDir, "rubric.json"), "utf-8"));
  const systemPrompt = fs.readFileSync(path.join(cfgDir, "system_prompt.txt"), "utf-8");
  return { assignment, rubric, systemPrompt };
}

function buildMessages(session) {
  const { assignment, rubric, systemPrompt } = session;
  const context =
    `ASSIGNMENT: ${assignment.title}\n` +
    `OBJECTIVES: ${JSON.stringify(assignment.objectives)}\n` +
    `RUBRIC: ${JSON.stringify(rubric.criteria)}\n` +
    `POLICY: web_access=false\n`;

  const msgs = [{ role: "system", content: systemPrompt + "\n\n" + context }];
  const hist = session.history.slice(-12);
  for (const m of hist) msgs.push(m);
  return msgs;
}

// rotas
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

// 1) criar sessão
app.post("/session", (_req, res) => {
  const id = Math.random().toString(36).slice(2, 14);
  const { assignment, rubric, systemPrompt } = loadConfigs();
  const sess = { assignment, rubric, systemPrompt, history: [], submissionPath: null };
  SESSIONS.set(id, sess);

  const dir = path.join(__dirname, "data", "submissions", id);
  fs.mkdirSync(dir, { recursive: true });

  res.json({ session_id: id });
});

// 2) upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const session = req.query.session;
    const dir = path.join(__dirname, "data", "submissions", String(session || "unknown"));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });


app.post("/upload", upload.single("file"), async (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const fileRef = req.file.path;
  sess.submissionPath = fileRef;

  // Mensagem inicial do assistente após upload
  const initialPrompt = "Por favor, me conte sobre o trabalho que você acabou de enviar. Quais foram os principais desafios? O que você gostaria de destacar?";
  // Adiciona mensagem do assistente ao histórico
  const messages = buildMessages(sess);
  messages.push({ role: "assistant", content: initialPrompt });
  sess.history.push({ role: "assistant", content: initialPrompt });

  res.json({ ok: true, file_ref: fileRef, assistant: initialPrompt });
});

// 3) chat
app.post("/chat", async (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const message = (req.body?.message || "").toString();
  if (!message) return res.status(400).json({ error: "empty message" });

  sess.history.push({ role: "user", content: message });

  const messages = buildMessages(sess);

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    temperature: 0.2
  });

  const assistant = completion.choices[0].message.content.trim();
  sess.history.push({ role: "assistant", content: assistant });

  res.json({ assistant });
});

// 4) finalizar (heurística simples)
app.post("/finalize", (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const userText = sess.history.filter(m => m.role === "user").map(m => m.content).join(" ").toLowerCase();

  const objectives = sess.assignment.objectives;
  let hits = 0;
  for (const obj of objectives) {
    // proxy ridiculamente simples só para MVP
    const tokens = obj.toString().toLowerCase().split(/\W+/).filter(Boolean);
    if (tokens.some(t => userText.includes(t))) hits += 1;
  }
  const coverage = Math.min(hits / objectives.length, 1);
  const clarity = Math.min(userText.length / 600, 1);
  const score = Math.round(10 * (0.6 * coverage + 0.4 * clarity) * 10) / 10;

  const breakdown = {
    C1: Math.round(10 * coverage * 0.4 * 10) / 10,
    C2: Math.round(10 * coverage * 0.4 * 10) / 10,
    C3: Math.round(10 * clarity * 0.2 * 10) / 10
  };

  res.json({ score_total: score, breakdown });
});

app.listen(PORT, () => {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY ausente no .env");
  }
  console.log(`TA-Assignment MVP rodando em http://localhost:${PORT}`);
});

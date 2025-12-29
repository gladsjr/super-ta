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
const PORT = process.env.PORT || 5000;

// memória volátil por sessão (MVP sem DB)
const SESSIONS = new Map();

// static
app.use("/static", express.static(path.join(__dirname, "static")));
app.use(express.json({ limit: "2mb" }));

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = "gpt-4o-mini";

// helpers
function loadSystemPrompt() {
  const cfgDir = path.join(__dirname, "config");
  const systemPrompt = fs.readFileSync(path.join(cfgDir, "system_prompt.txt"), "utf-8");
  return systemPrompt;
}

// rotas
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

// 1) criar sessão
app.post("/session", (_req, res) => {
  const id = Math.random().toString(36).slice(2, 14);
  const systemPrompt = loadSystemPrompt();
  const sess = { systemPrompt, history: [], submissionPath: null, openaiFileId: null };
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

  try {
    // 1) Upload file to OpenAI Files API
    const fileUpload = await openai.files.create({
      file: fs.createReadStream(fileRef),
      purpose: "user_data"
    });
    sess.openaiFileId = fileUpload.id;

    // 2) Call Responses API with system prompt and file
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      instructions: sess.systemPrompt,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Este é o trabalho do aluno. Por favor, analise e inicie a avaliação."
            },
            {
              type: "input_file",
              file_id: fileUpload.id
            }
          ]
        }
      ]
    });

    const assistantMessage = response.output_text || "Arquivo recebido. Podemos iniciar nossa avaliação?";
    sess.history.push({ role: "assistant", content: assistantMessage });

    res.json({ ok: true, file_ref: fileRef, assistant: assistantMessage });
  } catch (error) {
    console.error("Erro ao processar arquivo com OpenAI:", error);
    res.status(500).json({ error: "Erro ao processar arquivo com a IA" });
  }
});

// 3) chat
app.post("/chat", async (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const message = (req.body?.message || "").toString();
  if (!message) return res.status(400).json({ error: "empty message" });

  sess.history.push({ role: "user", content: message });

  try {
    // Build input with file context if available
    const userContent = [];
    userContent.push({ type: "input_text", text: message });
    
    if (sess.openaiFileId) {
      userContent.push({ type: "input_file", file_id: sess.openaiFileId });
    }

    // Build conversation history for context
    const inputMessages = sess.history.slice(0, -1).map(m => ({
      role: m.role,
      content: m.content
    }));

    // Add current user message with file
    inputMessages.push({
      role: "user",
      content: userContent
    });

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      instructions: sess.systemPrompt,
      input: inputMessages
    });

    const assistant = response.output_text || "Desculpe, não consegui processar sua mensagem.";
    sess.history.push({ role: "assistant", content: assistant });

    res.json({ assistant });
  } catch (error) {
    console.error("Erro no chat:", error);
    res.status(500).json({ error: "Erro ao processar mensagem" });
  }
});

// 4) finalizar (heurística simples baseada na conversa)
app.post("/finalize", (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const userMessages = sess.history.filter(m => m.role === "user");
  const userText = userMessages.map(m => m.content).join(" ");

  // Heurística simples: baseada em quantidade de interações e tamanho das respostas
  const interactions = Math.min(userMessages.length / 5, 1);
  const clarity = Math.min(userText.length / 600, 1);
  const score = Math.round(10 * (0.5 * interactions + 0.5 * clarity) * 10) / 10;

  const breakdown = {
    participacao: Math.round(10 * interactions * 10) / 10,
    clareza: Math.round(10 * clarity * 10) / 10
  };

  res.json({ score_total: score, breakdown });
});

app.listen(PORT, "0.0.0.0", () => {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY ausente no .env");
  }
  console.log(`TA-Assignment MVP rodando em http://0.0.0.0:${PORT}`);
});

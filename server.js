import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";

import { extractTextFromPdf } from "./src/ingest.js";
import { buildQuestionMasterPrompt } from "./src/prompts.js";

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

function computeRubricCoverage(rubric, questions) {
  if (!Array.isArray(rubric?.criteria) || !Array.isArray(questions)) return null;
  let covered = 0;
  for (const criterion of rubric.criteria) {
    const keywords = String(criterion.name || "")
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 5);
    if (!keywords.length) continue;
    const matched = questions.some(q => {
      const haystack = `${q?.texto || ""} ${q?.rationale_esperado || ""}`.toLowerCase();
      return keywords.some(word => haystack.includes(word));
    });
    if (matched) covered += 1;
  }
  if (!rubric.criteria.length) return null;
  return covered / rubric.criteria.length;
}

async function ensureSubmissionSummary(session) {
  if (!session.normalizedText) return null;
  if (session.submissionSummary) return session.submissionSummary;
  if (session.summaryInFlight) {
    return session.summaryInFlight;
  }

  session.summaryInFlight = (async () => {
    const prompt =
      "Resuma o trabalho abaixo em 200 a 400 tokens. Destaque objetivos, metodologia, resultados e pontos a revisar." +
      "\nMantenha o tom neutro e acadêmico." +
      "\n\nTRABALHO NORMALIZADO:\n" +
      session.normalizedText;

    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Você sintetiza trabalhos acadêmicos para apoiar monitores." },
          { role: "user", content: prompt }
        ]
      });

      const summary = completion.choices[0]?.message?.content?.trim?.() || "";
      session.submissionSummary = summary;
      return summary;
    } catch (error) {
      console.error(`[summary] Falha ao gerar resumo da submissão: ${error.message}`);
      session.submissionSummary = "";
      return "";
    }
  })();

  try {
    return await session.summaryInFlight;
  } finally {
    session.summaryInFlight = null;
  }
}

async function buildMessages(session) {
  const { assignment, rubric, systemPrompt } = session;
  const context =
    `ASSIGNMENT: ${assignment.title}\n` +
    `OBJECTIVES: ${JSON.stringify(assignment.objectives)}\n` +
    `RUBRIC: ${JSON.stringify(rubric.criteria)}\n` +
    `POLICY: web_access=false\n`;

  let extendedContext = context;
  if (session.normalizedText) {
    const summary = await ensureSubmissionSummary(session);
    if (summary) {
      extendedContext += `SUBMISSION_SUMMARY: ${summary}\n`;
    }
  }

  const msgs = [{ role: "system", content: systemPrompt + "\n\n" + extendedContext }];
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
  const sess = {
    assignment,
    rubric,
    systemPrompt,
    history: [],
    submissionPath: null,
    normalizedText: null,
    submissionSummary: null,
    summaryInFlight: null,
    questions: null
  };
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

  if (!req.file?.path) {
    return res.status(400).json({ error: "missing file" });
  }

  const fileRef = req.file.path;
  sess.submissionPath = fileRef;

  let extraction;
  try {
    extraction = await extractTextFromPdf(fileRef, {
      openai,
      maxPages: 30,
      model: OPENAI_MODEL,
      ocrConcurrency: 4
    });
  } catch (error) {
    console.error(`[upload] Falha na ingestão do PDF: ${error.message}`);
    return res.status(500).json({ error: "failed_to_ingest_pdf" });
  }

  const submissionDir = path.dirname(fileRef);
  const normalizedPath = path.join(submissionDir, "submission.md");
  fs.writeFileSync(normalizedPath, extraction.text, "utf-8");

  sess.normalizedText = extraction.text;
  sess.submissionSummary = null;
  sess.summaryInFlight = null;
  sess.questions = null;

  const prompt = buildQuestionMasterPrompt(extraction.text, sess.assignment, sess.rubric);

  let questionsPayload = null;
  let responseText = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userPrompt =
      attempt === 0
        ? prompt
        : `${prompt}\n\nResponda exatamente no JSON exigido, sem comentários adicionais.`;
    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Você gera roteiros de perguntas avaliativas em JSON estrito." },
          { role: "user", content: userPrompt }
        ]
      });

      responseText = completion.choices[0]?.message?.content?.trim?.() || "";
      questionsPayload = JSON.parse(responseText);
      if (!Array.isArray(questionsPayload.perguntas)) {
        throw new Error("Campo 'perguntas' ausente no JSON");
      }
      if (questionsPayload.perguntas.length < 10 || questionsPayload.perguntas.length > 14) {
        console.warn(
          `[upload] JSON retornou ${questionsPayload.perguntas.length} perguntas (fora da faixa recomendada de 10-14).`
        );
      }
      break;
    } catch (error) {
      if (attempt === 1) {
        console.error(
          `[upload] Falha ao gerar perguntas (tentativa ${attempt + 1}): ${error.message}`,
          { responseText }
        );
      } else {
        console.error(`[upload] Falha ao gerar perguntas (tentativa ${attempt + 1}): ${error.message}`);
      }
    }
  }

  if (!questionsPayload) {
    return res.status(500).json({ error: "failed_to_generate_questions" });
  }

  const questionsPath = path.join(submissionDir, "questions.json");
  fs.writeFileSync(questionsPath, JSON.stringify(questionsPayload, null, 2), "utf-8");

  sess.questions = questionsPayload.perguntas;

  const assistantMessage = "Conferi seu trabalho e gerei um roteiro de perguntas. Podemos começar pela Q1?";
  sess.history.push({ role: "assistant", content: assistantMessage });

  res.json({
    ok: true,
    file_ref: fileRef,
    pages: extraction.pagesCount,
    ocr_used: extraction.ocrUsed,
    generated: Array.isArray(sess.questions) ? sess.questions.length : 0,
    assistant: assistantMessage
  });
});

// 3) chat
app.post("/chat", async (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const message = (req.body?.message || "").toString();
  if (!message) return res.status(400).json({ error: "empty message" });

  sess.history.push({ role: "user", content: message });

  const messages = await buildMessages(sess);

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    temperature: 0.2
  });

  const assistant = completion.choices[0].message.content.trim();
  sess.history.push({ role: "assistant", content: assistant });

  res.json({ assistant });
});

app.get("/questions", (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  const submissionDir = path.join(__dirname, "data", "submissions", sessionId);
  const questionsPath = path.join(submissionDir, "questions.json");
  if (!fs.existsSync(questionsPath)) {
    return res.status(404).json({ error: "questions_not_ready" });
  }

  try {
    const raw = fs.readFileSync(questionsPath, "utf-8");
    const data = JSON.parse(raw);
    return res.json(data);
  } catch (error) {
    console.error(`[questions] Falha ao carregar questions.json: ${error.message}`);
    return res.status(500).json({ error: "failed_to_read_questions" });
  }
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

  if (Array.isArray(sess.questions) && sess.questions.length) {
    const rubricCoverage = computeRubricCoverage(sess.rubric, sess.questions);
    if (rubricCoverage !== null) {
      console.log(
        `[finalize] Cobertura simples da rubrica por perguntas: ${(rubricCoverage * 100).toFixed(1)}%`
      );
    }
  }

  res.json({ score_total: score, breakdown });
});

app.listen(PORT, () => {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY ausente no .env");
  }
  console.log(`TA-Assignment MVP rodando em http://localhost:${PORT}`);
});

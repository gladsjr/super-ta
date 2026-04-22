import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import yaml from "js-yaml";
import OpenAI from "openai";
import { MapBuilderAgent } from "./agents/MapBuilderAgent.js";
import { ComprehensionEvaluatorAgent } from "./agents/ComprehensionEvaluatorAgent.js";
import { ClarificationEvaluatorAgent } from "./agents/ClarificationEvaluatorAgent.js";
import {
  sessionMiddleware,
  seedInitialUsers,
  loginHandler,
  logoutHandler,
  meHandler,
} from "./auth.js";
import {
  newToken,
  requireAdmin,
  requireWorkToken,
  requireSubmissionToken,
  sanitizeLabel,
  parseDirName,
  submissionStatus,
  WORKS_ROOT,
  PROJECT_ROOT,
} from "./lib/middleware.js";
import log from "./lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// memória volátil por sessão (MVP sem DB)
const SESSIONS = new Map();

// static
app.use("/static", express.static(path.join(__dirname, "static")));
app.use(express.json({ limit: "2mb" }));
app.use(sessionMiddleware);

// Auth routes (public)
app.post("/login", loginHandler);
app.post("/logout", logoutHandler);
app.get("/me", meHandler);

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================================================
// MODEL CONFIGURATION
// Overridable via env vars. OPENAI_MODEL sets the default for all roles;
// per-role vars (OPENAI_MODEL_MAP_BUILDER etc.) take precedence when set.
// ============================================================================
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const MODELS = {
  DEFAULT:            DEFAULT_MODEL,
  MAP_BUILDER:        process.env.OPENAI_MODEL_MAP_BUILDER        || DEFAULT_MODEL,
  COMPREHENSION_EVAL: process.env.OPENAI_MODEL_COMPREHENSION_EVAL || DEFAULT_MODEL,
  CLARIFICATION_EVAL: process.env.OPENAI_MODEL_CLARIFICATION_EVAL || DEFAULT_MODEL,
  METHODOLOGY_EVAL:   process.env.OPENAI_MODEL_METHODOLOGY_EVAL   || DEFAULT_MODEL,
  PARAMETERS_EVAL:    process.env.OPENAI_MODEL_PARAMETERS_EVAL    || DEFAULT_MODEL
};

const OPENAI_MODEL = MODELS.DEFAULT;

// helpers
function loadSystemPrompt() {
  const cfgDir = path.join(__dirname, "config");
  const systemPrompt = fs.readFileSync(path.join(cfgDir, "system_prompt.txt"), "utf-8");
  return systemPrompt;
}

async function getConversationContext(conversationId, limit = 12) {
  const page = await openai.conversations.items.list(conversationId, { limit });
  const items = page?.data || [];
  const lines = items
    .filter(item => item?.type === 'message')
    .map(item => {
      const text = (item.content || [])
        .map(part => (part && typeof part.text === 'string') ? part.text : "")
        .filter(Boolean)
        .join("\n");
      if (!text) return null;
      return `${item.role}: ${text}`;
    })
    .filter(Boolean);

  return lines.reverse().join("\n");
}

function extractItemText(item) {
  if (item?.type !== 'message') return null;
  return (item.content || [])
    .map(part => (part && typeof part.text === 'string') ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

/**
 * Log only the newest item appended to a conversation (DEBUG level).
 * Avoids dumping the entire history on every turn.
 * DocumentMap payloads are summarized, never reprinted.
 */
async function logLastConvItem(conversationId, scope) {
  if (!log.enabled("debug")) return;
  try {
    const page = await openai.conversations.items.list(conversationId, { limit: 1, order: "desc" });
    const item = page?.data?.[0];
    if (!item) return;
    if (item.type !== 'message') {
      log.debug(scope, `+${item.type || 'unknown'}`);
      return;
    }
    const text = extractItemText(item) || "";
    if (text.startsWith('[DOCUMENT_MAP]')) {
      log.debug(scope, `+${item.role} [DOCUMENT_MAP] (stored, ${text.length} chars)`);
      return;
    }
    if (text.startsWith('[EVALUATION SIGNALS]')) {
      log.debug(scope, `+${item.role} [EVALUATION SIGNALS] (stored, ${text.length} chars)`);
      return;
    }
    log.debug(scope, `+${item.role} ${log.preview(text, 140)}`);
  } catch (err) {
    log.debug(scope, `logLastConvItem failed: ${err.message}`);
  }
}

/**
 * Full conversation dump (TRACE only — opt-in for deep debugging).
 */
async function logFullConv(conversationId, scope, limit = 20) {
  if (!log.enabled("trace")) return;
  const page = await openai.conversations.items.list(conversationId, { limit });
  const items = page?.data || [];
  const lines = items.map((item, index) => {
    if (item?.type === 'message') {
      const text = extractItemText(item);
      return `${index + 1}. [${item.role}] ${log.preview(text, 200)}`;
    }
    return `${index + 1}. [${item?.type || 'unknown'}]`;
  });
  log.trace(scope, `full conv (${items.length} items)\n${lines.join("\n")}`);
}

/**
 * Create Vector Store and index file for RAG (file_search)
 */
async function createVectorStoreWithFile(fileId, sessionId) {
  try {
    // Create a vector store (SDK v6+: vectorStores is at top level, not in beta)
    const vectorStore = await openai.vectorStores.create({
      name: `session_${sessionId}_documents`,
      file_ids: [fileId]
    });

    log.info("UPLOAD", `vector store ${vectorStore.id} created`);
    return vectorStore.id;
  } catch (error) {
    log.error("UPLOAD", `vector store creation failed: ${error.message}`);
    throw error; // Fail fast - this is a critical architectural component
  }
}

// ============================================================================
// AGENTS: COGNITIVE COMPONENTS
// ============================================================================

// Initialize agents (singletons) with configured models
const mapBuilderAgent = new MapBuilderAgent(openai, MODELS.MAP_BUILDER);
const comprehensionEvaluator = new ComprehensionEvaluatorAgent(openai, MODELS.COMPREHENSION_EVAL);
const clarificationEvaluator = new ClarificationEvaluatorAgent(openai, MODELS.CLARIFICATION_EVAL);

// ============================================================================
// EVALUATORS INFRASTRUCTURE
// ============================================================================

/**
 * Run all evaluators after student response
 * Uses agent-based evaluators with file_search
 */
async function runEvaluators(session, studentResponse) {
  const signals = [];

  if (!session.conversationId_eval) {
    throw new Error('Missing conversationId_eval for evaluators');
  }

  // Run both evaluator agents in parallel
  const [comprehensionSignal, clarificationSignal] = await Promise.all([
    comprehensionEvaluator.evaluate(
      session.conversationId_eval,
      session.vectorStoreId,
      session.documentMap,
      studentResponse
    ),
    clarificationEvaluator.evaluate(
      session.conversationId_eval,
      session.vectorStoreId,
      session.documentMap,
      studentResponse
    )
  ]);

  signals.push(comprehensionSignal, clarificationSignal);

  // Store signals in session
  session.evaluationSignals.push(...signals);

  // Log to eval conversation
  session.conv_eval.push({
    role: "system",
    content: `[EVALUATION SIGNALS] ${JSON.stringify(signals, null, 2)}`,
    metadata: { signals, timestamp: Date.now() }
  });

  await openai.conversations.items.create(session.conversationId_eval, {
    items: [{
      role: "developer",
      content: `[EVALUATION SIGNALS] ${JSON.stringify(signals, null, 2)}`
    }]
  });

  await logLastConvItem(session.conversationId_eval, "CONV:eval");

  return signals;
}

/**
 * Orchestrator: Decides next action based on evaluation signals
 */
async function orchestrateNextAction(session, signals) {
  const MAX_QUESTIONS = 8;
  const FOLLOWUP_THRESHOLD = 0.5;

  // Check if we've reached question limit
  if (session.questionCount >= MAX_QUESTIONS) {
    return { action: 'finalize', question: null };
  }

  // Check for low comprehension - needs follow-up
  const comprehensionSignal = signals.find(s => s.type === 'comprehension');
  if (comprehensionSignal && comprehensionSignal.confidence < FOLLOWUP_THRESHOLD) {
    if (comprehensionSignal.data.suggestedFollowUp) {
      return {
        action: 'followup',
        question: comprehensionSignal.data.suggestedFollowUp
      };
    }
  }

  // Check for clarification needs
  const clarificationSignal = signals.find(s => s.type === 'clarification');
  if (clarificationSignal && clarificationSignal.data.needsClarification) {
    if (clarificationSignal.data.suggestedQuestion) {
      return {
        action: 'followup',
        question: clarificationSignal.data.suggestedQuestion
      };
    }
  }

  // Continue with new question
  return { action: 'continue', question: null };
}

/**
 * Generate next question using LLM with full context
 */
async function generateNextQuestion(session) {
  const documentContext = session.documentMap ?
    `**Resumo do Documento:**\n${JSON.stringify(session.documentMap, null, 2)}\n\n` : "";

  if (!session.conversationId_chat) {
    throw new Error('Missing conversationId_chat for chat generation');
  }

  const recentChat = await getConversationContext(session.conversationId_chat, 12);

  const prompt = `${session.systemPrompt}

${documentContext}

**Conversa até agora:**
${recentChat}

**Tarefa:** Gere a próxima pergunta para o aluno. Foque em:
- Aspectos não claros ou fracos do documento
- Compreensão de metodologia e cálculos
- Justificativas para escolhas feitas

Retorne APENAS a pergunta, sem texto adicional.`;

  try {
    const tools = session.vectorStoreId ? [{
      type: "file_search",
      vector_store_ids: [session.vectorStoreId]
    }] : [];

    // If no vector store, attach file directly
    const input = [];
    if (session.vectorStoreId) {
      // Use vector store for RAG
      input.push({ role: "user", content: "Gere a próxima pergunta." });
    } else if (session.openaiFileId) {
      // Fallback: attach file directly
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: "Gere a próxima pergunta." },
          { type: "input_file", file_id: session.openaiFileId }
        ]
      });
    } else {
      input.push({ role: "user", content: "Gere a próxima pergunta." });
    }

    const payload = {
      model: OPENAI_MODEL,
      instructions: prompt,
      tools,
      input
    };

    log.prompt("QUESTION_GEN", prompt);
    const response = await log.span("QUESTION_GEN", "responses.create", () =>
      openai.responses.create(payload)
    );

    return response.output_text || "Pode me explicar melhor esse ponto do seu trabalho?";
  } catch (error) {
    log.error("QUESTION_GEN", `failed: ${error.message}`);
    throw error;
  }
}

// ============================================================================
// ROUTES
// ============================================================================

// rotas
// ============================================================================
// STATIC PAGES
// ============================================================================
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "admin.html"));
});
app.get("/trabalho", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "trabalho.html"));
});
app.get("/envio", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "envio.html"));
});
app.get("/w/:workToken", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "professor.html"));
});
app.get("/s/:submissionToken", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "student.html"));
});

// ============================================================================
// MULTER: two storages — enunciado (professor) and student upload
// ============================================================================
const enunciadoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      fs.mkdirSync(req.work.full_path, { recursive: true });
      cb(null, req.work.full_path);
    },
    filename: (_req, _file, cb) => cb(null, "enunciado.pdf"),
  }),
});
const studentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      fs.mkdirSync(req.submission.full_path, { recursive: true });
      cb(null, req.submission.full_path);
    },
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================
app.get("/admin/works", requireAdmin, (req, res) => {
  try {
    fs.mkdirSync(WORKS_ROOT, { recursive: true });
    const works = [];
    for (const e of fs.readdirSync(WORKS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const parsed = parseDirName(e.name);
      if (!parsed) continue;
      const workFullPath = path.join(WORKS_ROOT, e.name);
      const subsRoot = path.join(workFullPath, "submissions");
      let pending = 0, in_progress = 0, finalized = 0;
      if (fs.existsSync(subsRoot)) {
        for (const se of fs.readdirSync(subsRoot, { withFileTypes: true })) {
          if (!se.isDirectory()) continue;
          if (!parseDirName(se.name)) continue;
          const status = submissionStatus(path.join(subsRoot, se.name));
          if (status === "pending") pending++;
          else if (status === "in_progress") in_progress++;
          else if (status === "finalized") finalized++;
        }
      }
      works.push({
        work_token: parsed.token,
        name: parsed.label,
        assignment_pdf: fs.existsSync(path.join(workFullPath, "enunciado.pdf")),
        pending,
        in_progress,
        finalized,
      });
    }
    res.json({ works });
  } catch (err) {
    log.error("ADMIN", `list works failed: ${err.message}`);
    res.status(500).json({ error: "failed to list works" });
  }
});

app.post("/admin/works", requireAdmin, (req, res) => {
  let name;
  try { name = sanitizeLabel(req.body?.name); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const workToken = newToken();
    const dirName = `${workToken}-${name}`;
    fs.mkdirSync(path.join(WORKS_ROOT, dirName), { recursive: true });
    log.info("ADMIN", `work created token=${workToken} name="${name}" by=${req.session.user.username}`);
    res.json({ work: { work_token: workToken, name } });
  } catch (err) {
    log.error("ADMIN", `create work failed: ${err.message}`);
    res.status(500).json({ error: "failed to create work" });
  }
});

// ============================================================================
// PROFESSOR ROUTES (bearer auth via work_token)
// ============================================================================
app.get("/w/:workToken/info", requireWorkToken, (req, res) => {
  try {
    const subsRoot = path.join(req.work.full_path, "submissions");
    const submissions = [];
    if (fs.existsSync(subsRoot)) {
      for (const e of fs.readdirSync(subsRoot, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const parsed = parseDirName(e.name);
        if (!parsed) continue;
        submissions.push({
          submission_token: parsed.token,
          student_label: parsed.label,
          status: submissionStatus(path.join(subsRoot, e.name)),
        });
      }
    }
    const hasInterviewer = fs.existsSync(path.join(req.work.full_path, "interviewer.yaml"));
    res.json({
      work: {
        name: req.work.name,
        has_enunciado: !!req.work.assignment_pdf,
        has_interviewer: hasInterviewer,
      },
      submissions,
    });
  } catch (err) {
    log.error("WORK", `info failed: ${err.message}`);
    res.status(500).json({ error: "failed to load work info" });
  }
});

// ---- Interviewer templates (shared) ----
const INTERVIEWER_TEMPLATES_DIR = path.join(__dirname, "config", "interviewers");

function listInterviewerTemplates() {
  if (!fs.existsSync(INTERVIEWER_TEMPLATES_DIR)) return [];
  return fs
    .readdirSync(INTERVIEWER_TEMPLATES_DIR)
    .filter(f => /\.ya?ml$/i.test(f))
    .sort();
}

app.get("/interviewers/templates", (_req, res) => {
  res.json({ templates: listInterviewerTemplates().map(filename => ({ filename })) });
});

app.get("/interviewers/templates/:filename", (req, res) => {
  const filename = String(req.params.filename);
  if (!listInterviewerTemplates().includes(filename)) {
    return res.status(404).json({ error: "template not found" });
  }
  const content = fs.readFileSync(path.join(INTERVIEWER_TEMPLATES_DIR, filename), "utf8");
  res.type("text/plain").send(content);
});

// ---- Per-work interviewer YAML ----
app.get("/w/:workToken/interviewer", requireWorkToken, (req, res) => {
  const p = path.join(req.work.full_path, "interviewer.yaml");
  if (!fs.existsSync(p)) return res.json({ yaml: null });
  res.json({ yaml: fs.readFileSync(p, "utf8") });
});

app.post("/w/:workToken/interviewer", requireWorkToken, express.json({ limit: "256kb" }), (req, res) => {
  const content = String(req.body?.yaml ?? "");
  if (!content.trim()) return res.status(400).json({ error: "yaml content required" });
  try {
    yaml.load(content);
  } catch (err) {
    return res.status(400).json({ error: "invalid YAML", detail: err.message });
  }
  fs.mkdirSync(req.work.full_path, { recursive: true });
  fs.writeFileSync(path.join(req.work.full_path, "interviewer.yaml"), content, "utf8");
  log.info("WORK", `interviewer saved work=${req.work.work_token} bytes=${content.length}`);
  res.json({ ok: true });
});

app.get("/w/:workToken/enunciado", requireWorkToken, (req, res) => {
  const p = path.join(req.work.full_path, "enunciado.pdf");
  if (!fs.existsSync(p)) return res.status(404).json({ error: "enunciado not uploaded" });
  res.sendFile(p);
});

app.post("/w/:workToken/enunciado", requireWorkToken, enunciadoUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  const rel = path.relative(PROJECT_ROOT, req.file.path);
  log.info("WORK", `enunciado uploaded work=${req.work.work_token} path=${rel}`);
  res.json({ ok: true, path: rel });
});

app.post("/w/:workToken/submissions", requireWorkToken, (req, res) => {
  let baseLabel;
  try { baseLabel = sanitizeLabel(req.body?.label); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const rawCount = Number(req.body?.count ?? 1);
  const count = Number.isFinite(rawCount) && rawCount > 0 && rawCount <= 50 ? Math.floor(rawCount) : 1;

  try {
    const rows = [];
    const subsRoot = path.join(req.work.full_path, "submissions");
    fs.mkdirSync(subsRoot, { recursive: true });
    for (let i = 0; i < count; i++) {
      const submissionToken = newToken();
      const label = count > 1 ? `${baseLabel}-${i + 1}` : baseLabel;
      fs.mkdirSync(path.join(subsRoot, `${submissionToken}-${label}`), { recursive: true });
      rows.push({ submission_token: submissionToken, student_label: label, status: "pending" });
    }
    log.info("SUBMISSION", `created ${count} submission(s) for work=${req.work.work_token}`);
    res.json({ submissions: rows });
  } catch (err) {
    log.error("SUBMISSION", `create failed: ${err.message}`);
    res.status(500).json({ error: "failed to create submissions" });
  }
});

// ============================================================================
// STUDENT ROUTES (bearer auth via submission_token)
// SESSIONS map is keyed by submission_token.
// ============================================================================

function sessionToClientState(sess) {
  return {
    currentPhase: sess.currentPhase,
    questionCount: sess.questionCount,
    hasUpload: !!sess.submissionPath,
    chat: sess.conv_chat.map(m => ({ role: m.role, content: m.content })),
  };
}

app.post("/s/:submissionToken/start", requireSubmissionToken, async (req, res) => {
  const token = req.submission.submission_token;
  if (req.submission.status === "finalized") {
    return res.status(403).json({ error: "submission already finalized" });
  }

  try {
    let sess = SESSIONS.get(token);
    if (!sess) {
      const systemPrompt = loadSystemPrompt();
      const [chatConversation, evalConversation] = await Promise.all([
        openai.conversations.create({ metadata: { submission_token: token, type: "chat" } }),
        openai.conversations.create({ metadata: { submission_token: token, type: "eval" } }),
      ]);
      sess = {
        systemPrompt,
        submissionToken: token,
        workToken: req.work.work_token,
        conversationId_chat: chatConversation.id,
        conversationId_eval: evalConversation.id,
        conv_chat: [],
        conv_eval: [],
        history: [],
        documentMap: null,
        submissionPath: null,
        openaiFileId: null,
        vectorStoreId: null,
        currentPhase: "awaiting_upload",
        questionCount: 0,
        evaluationSignals: [],
      };
      SESSIONS.set(token, sess);
      fs.mkdirSync(req.submission.full_path, { recursive: true });
      log.info("SUBMISSION", `start token=${token} work=${req.work.work_token} chat=${chatConversation.id} eval=${evalConversation.id}`);
    } else {
      log.info("SUBMISSION", `resume token=${token} phase=${sess.currentPhase} qn=${sess.questionCount}`);
    }

    res.json({
      work: { name: req.work.name, has_enunciado: !!req.work.assignment_pdf },
      submission: { status: req.submission.status === "pending" ? "in_progress" : req.submission.status, student_label: req.submission.student_label },
      session: sessionToClientState(sess),
    });
  } catch (err) {
    log.error("SUBMISSION", `start failed: ${err.message}`);
    res.status(500).json({ error: "failed to start submission" });
  }
});

app.post("/s/:submissionToken/upload", requireSubmissionToken, studentUpload.single("file"), async (req, res) => {
  const token = req.submission.submission_token;
  if (req.submission.status === "finalized") return res.status(403).json({ error: "finalized" });
  const sess = SESSIONS.get(token);
  if (!sess) return res.status(400).json({ error: "call /start first" });
  if (!req.file) return res.status(400).json({ error: "file required" });

  const fileRef = req.file.path;
  sess.submissionPath = fileRef;

  try {
    const fileName = path.basename(fileRef);
    log.info("UPLOAD", `student file=${fileName} submission=${token}`);
    const fileUpload = await openai.files.create({ file: fs.createReadStream(fileRef), purpose: "user_data" });
    sess.openaiFileId = fileUpload.id;
    log.info("UPLOAD", `openai file=${fileUpload.id}`);

    sess.vectorStoreId = await createVectorStoreWithFile(fileUpload.id, token);

    sess.documentMap = await mapBuilderAgent.generateDocumentMap(
      sess.conversationId_eval,
      sess.openaiFileId
    );

    await openai.conversations.items.create(sess.conversationId_eval, {
      items: [{ role: "developer", content: `[DOCUMENT_MAP] ${JSON.stringify(sess.documentMap, null, 2)}` }],
    });
    await logLastConvItem(sess.conversationId_eval, "CONV:eval");

    const payload = {
      model: OPENAI_MODEL,
      instructions: sess.systemPrompt,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Este é o trabalho do aluno. Por favor, analise e inicie a avaliação." },
          { type: "input_file", file_id: fileUpload.id },
        ],
      }],
    };

    log.prompt("UPLOAD:intro", sess.systemPrompt);
    const response = await log.span("UPLOAD", "intro responses.create", () => openai.responses.create(payload));
    const assistantMessage = response.output_text || "Arquivo recebido. Podemos iniciar nossa avaliação?";

    sess.conv_chat.push({ role: "assistant", content: assistantMessage });
    sess.conv_eval.push({ role: "assistant", content: assistantMessage, metadata: { documentMap: sess.documentMap } });
    sess.history = sess.conv_chat;

    await openai.conversations.items.create(sess.conversationId_chat, {
      items: [{ role: "assistant", content: assistantMessage }],
    });
    await openai.conversations.items.create(sess.conversationId_eval, {
      items: [{ role: "assistant", content: assistantMessage }],
    });

    log.info("CHAT", `assistant (intro) ${log.preview(assistantMessage, 120)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    sess.currentPhase = "interviewing";

    res.json({ ok: true, assistant: assistantMessage });
  } catch (error) {
    log.error("UPLOAD", `failed: ${error.message}`);
    res.status(500).json({ error: "Erro ao processar arquivo com a IA" });
  }
});

app.post("/s/:submissionToken/chat", requireSubmissionToken, async (req, res) => {
  const token = req.submission.submission_token;
  if (req.submission.status === "finalized") return res.status(403).json({ error: "finalized" });
  const sess = SESSIONS.get(token);
  if (!sess) return res.status(400).json({ error: "call /start first" });
  if (!sess.vectorStoreId || !sess.documentMap) {
    return res.status(400).json({ error: "envie o trabalho (PDF) antes de iniciar a conversa" });
  }

  const message = (req.body?.message || "").toString();
  if (!message) return res.status(400).json({ error: "empty message" });

  sess.conv_chat.push({ role: "user", content: message });
  sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
  sess.history = sess.conv_chat;

  try {
    await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
    await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "user", content: message }] });

    log.info("CHAT", `user #${sess.questionCount + 1} ${log.preview(message, 140)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    log.info("TURN", `q#${sess.questionCount + 1} evaluators=Comprehension,Clarification (parallel)`);
    const signals = await runEvaluators(sess, message);
    log.debug("TURN", `${signals.length} signals generated`);

    const decision = await orchestrateNextAction(sess, signals);
    log.info("ORCH", `decision=${decision.action}`);

    let assistantResponse;
    if (decision.action === "followup") {
      assistantResponse = decision.question;
    } else if (decision.action === "continue") {
      assistantResponse = await generateNextQuestion(sess);
    } else if (decision.action === "finalize") {
      assistantResponse = "Obrigado pelas respostas. Acredito que já tenho informações suficientes para avaliar. Use o botão 'Finalizar' quando estiver pronto.";
      sess.currentPhase = "finalizing";
    } else {
      assistantResponse = await generateNextQuestion(sess);
    }

    sess.conv_chat.push({ role: "assistant", content: assistantResponse });
    sess.conv_eval.push({ role: "assistant", content: assistantResponse, metadata: { decision, timestamp: Date.now() } });
    sess.history = sess.conv_chat;

    await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: assistantResponse }] });
    await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: assistantResponse }] });

    log.info("CHAT", `assistant ${log.preview(assistantResponse, 140)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    sess.questionCount++;
    res.json({ assistant: assistantResponse });
  } catch (error) {
    log.error("CHAT", `failed: ${error.message}`);
    res.status(500).json({ error: "Erro ao processar mensagem" });
  }
});

app.post("/s/:submissionToken/finalize", requireSubmissionToken, async (req, res) => {
  const token = req.submission.submission_token;
  if (req.submission.status === "finalized" && req.submission.final_report) {
    return res.json(req.submission.final_report);
  }
  const sess = SESSIONS.get(token);
  if (!sess) return res.status(400).json({ error: "no active session; start and complete the interview first" });

  try {
    log.info("FINAL", `start submission=${token} signals=${sess.evaluationSignals.length} questions=${sess.questionCount}`);

    const rubricScores = await calculateRubricScores(sess, sess.evaluationSignals);
    const report = generateFinalReport(sess, rubricScores);

    fs.writeFileSync(
      path.join(req.submission.full_path, "final_report.json"),
      JSON.stringify(report, null, 2),
      "utf8"
    );

    log.info("FINAL", `submission=${token} C1=${report.breakdown.C1_compreensao} C2=${report.breakdown.C2_metodologia} C3=${report.breakdown.C3_parametros} total=${report.score_total}`);
    SESSIONS.delete(token);
    res.json(report);
  } catch (error) {
    log.error("FINAL", `failed: ${error.message}`);
    res.status(500).json({ error: "Erro ao gerar avaliação final" });
  }
});

/**
 * Calculate scores based on rubric criteria
 */
async function calculateRubricScores(session, signals) {
  // C1: Compreensão do conteúdo (40%)
  const comprehensionSignals = signals.filter(s => s.type === 'comprehension');
  const avgComprehension = comprehensionSignals.length > 0
    ? comprehensionSignals.reduce((sum, s) => sum + s.confidence, 0) / comprehensionSignals.length
    : 0.5;

  // C2: Correção da metodologia (40%) - requires deeper analysis
  const c2Score = await evaluateMethodology(session);

  // C3: Valores adequados para parâmetros (20%)
  const c3Score = await evaluateParameters(session);

  return {
    C1: { score: avgComprehension * 10, weight: 0.4 },
    C2: { score: c2Score, weight: 0.4 },
    C3: { score: c3Score, weight: 0.2 }
  };
}

/**
 * Evaluate methodology correctness (C2)
 */
async function evaluateMethodology(session) {
  const documentContext = session.documentMap ? JSON.stringify(session.documentMap, null, 2) : "";
  const conversationSummary = session.conv_chat.slice(-10).map(m =>
    `${m.role}: ${m.content}`
  ).join('\n');

  const prompt = `Avalie a correção da metodologia usada no trabalho.

**Documento:**
${documentContext}

**Conversa com o aluno:**
${conversationSummary}

Retorne JSON:
{
  "score": 0-10,
  "rationale": "Justificativa breve"
}`;

  try {
    log.prompt("EVAL:Methodology", prompt);
    const response = await log.span("EVAL:Methodology", "responses.create", () =>
      openai.responses.create({
        model: MODELS.METHODOLOGY_EVAL,
        instructions: prompt,
        input: [{ role: "user", content: "Avalie a metodologia." }]
      })
    );

    const outputText = response.output_text || "";
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Methodology evaluator returned no parseable JSON");
    }
    const result = JSON.parse(jsonMatch[0]);
    if (typeof result.score !== "number") {
      throw new Error("Methodology evaluator returned invalid score");
    }
    log.info("EVAL:Methodology", `score=${result.score}`);
    return result.score;
  } catch (error) {
    log.error("EVAL:Methodology", `failed: ${error.message}`);
    throw error; // Fail fast - critical scoring component
  }
}

/**
 * Evaluate parameter adequacy (C3)
 */
async function evaluateParameters(session) {
  const documentContext = session.documentMap ? JSON.stringify(session.documentMap, null, 2) : "";

  const prompt = `Avalie se os parâmetros/valores usados no trabalho são adequados.

**Documento:**
${documentContext}

Retorne JSON:
{
  "score": 0-10,
  "rationale": "Justificativa breve"
}`;

  try {
    log.prompt("EVAL:Parameters", prompt);
    const response = await log.span("EVAL:Parameters", "responses.create", () =>
      openai.responses.create({
        model: MODELS.PARAMETERS_EVAL,
        instructions: prompt,
        input: [{ role: "user", content: "Avalie os parâmetros." }]
      })
    );

    const outputText = response.output_text || "";
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Parameters evaluator returned no parseable JSON");
    }
    const result = JSON.parse(jsonMatch[0]);
    if (typeof result.score !== "number") {
      throw new Error("Parameters evaluator returned invalid score");
    }
    log.info("EVAL:Parameters", `score=${result.score}`);
    return result.score;
  } catch (error) {
    log.error("EVAL:Parameters", `failed: ${error.message}`);
    throw error; // Fail fast - critical scoring component
  }
}

/**
 * Generate final evaluation report
 */
function generateFinalReport(session, rubricScores) {
  // Calculate weighted total
  const total = Object.entries(rubricScores).reduce((sum, [key, data]) => {
    return sum + (data.score * data.weight);
  }, 0);

  return {
    score_total: Math.round(total * 10) / 10,
    breakdown: {
      C1_compreensao: Math.round(rubricScores.C1.score * 10) / 10,
      C2_metodologia: Math.round(rubricScores.C2.score * 10) / 10,
      C3_parametros: Math.round(rubricScores.C3.score * 10) / 10
    },
    metadata: {
      questionCount: session.questionCount,
      totalSignals: session.evaluationSignals.length,
      phase: session.currentPhase
    }
  };
}

app.listen(PORT, "0.0.0.0", async () => {
  if (!process.env.OPENAI_API_KEY) {
    log.warn("BOOT", "OPENAI_API_KEY ausente no .env");
  }
  try {
    await seedInitialUsers();
  } catch (err) {
    log.error("BOOT", `seedInitialUsers failed: ${err.message}`);
  }
  log.info("BOOT", `server listening http://0.0.0.0:${PORT} log_level=${log.level} model=${OPENAI_MODEL}`);
});

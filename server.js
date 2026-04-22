import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
import { MapBuilderAgent } from "./agents/MapBuilderAgent.js";
import { ComprehensionEvaluatorAgent } from "./agents/ComprehensionEvaluatorAgent.js";
import { ClarificationEvaluatorAgent } from "./agents/ClarificationEvaluatorAgent.js";
import log from "./lib/logger.js";

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
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

// 1) criar sessão
app.post("/session", async (_req, res) => {
  const id = Math.random().toString(36).slice(2, 14);
  const systemPrompt = loadSystemPrompt();

  try {
    const [chatConversation, evalConversation] = await Promise.all([
      openai.conversations.create({ metadata: { session_id: id, type: "chat" } }),
      openai.conversations.create({ metadata: { session_id: id, type: "eval" } })
    ]);

    const sess = {
      systemPrompt,
      // Dual conversations (explicitly created)
      conversationId_chat: chatConversation.id,   // Student-facing conversation
      conversationId_eval: evalConversation.id,   // Internal evaluation conversation
      conv_chat: [],        // Local cache (for display)
      conv_eval: [],        // Local cache (for logging)
      history: [],          // Backward compatibility (alias to conv_chat)
      // Document understanding
      documentMap: null,    // Global document summary
      submissionPath: null,
      openaiFileId: null,
      vectorStoreId: null,  // For RAG/file_search
      // State machine
      currentPhase: 'awaiting_upload',  // awaiting_upload, interviewing, finalizing
      questionCount: 0,
      evaluationSignals: [] // Accumulated signals from evaluators
    };
    SESSIONS.set(id, sess);

    const dir = path.join(__dirname, "data", "submissions", id);
    fs.mkdirSync(dir, { recursive: true });

    log.info("SESSION", `created id=${id} chat=${chatConversation.id} eval=${evalConversation.id}`);

    res.json({ session_id: id });
  } catch (error) {
    log.error("SESSION", `creation failed: ${error.message}`);
    res.status(500).json({ error: "Erro ao criar sessão" });
  }
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

  if (!sess.conversationId_chat || !sess.conversationId_eval) {
    return res.status(500).json({ error: "Sessão sem conversations válidas" });
  }

  const fileRef = req.file.path;
  sess.submissionPath = fileRef;

  try {
    // 1) Upload file to OpenAI Files API
    const fileName = path.basename(fileRef);
    log.info("UPLOAD", `file=${fileName} session=${sessionId}`);
    const fileUpload = await openai.files.create({
      file: fs.createReadStream(fileRef),
      purpose: "user_data"
    });
    sess.openaiFileId = fileUpload.id;
    log.info("UPLOAD", `openai file=${fileUpload.id}`);

    // 2) Create Vector Store for RAG/file_search (needed for MapBuilder)
    sess.vectorStoreId = await createVectorStoreWithFile(fileUpload.id, sessionId);

    // 3) Generate DocumentMap using MapBuilder Agent (fail fast if error)
    sess.documentMap = await mapBuilderAgent.generateDocumentMap(
      sess.conversationId_eval,
      sess.openaiFileId
    );

    await openai.conversations.items.create(sess.conversationId_eval, {
      items: [{
        role: "developer",
        content: `[DOCUMENT_MAP] ${JSON.stringify(sess.documentMap, null, 2)}`
      }]
    });

    await logLastConvItem(sess.conversationId_eval, "CONV:eval");

    // 4) Call Responses API with system prompt and file
    const payload = {
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
    };

    log.prompt("UPLOAD:intro", sess.systemPrompt);
    const response = await log.span("UPLOAD", "intro responses.create", () =>
      openai.responses.create(payload)
    );

    const assistantMessage = response.output_text || "Arquivo recebido. Podemos iniciar nossa avaliação?";

    // Store in both conversations
    sess.conv_chat.push({ role: "assistant", content: assistantMessage });
    sess.conv_eval.push({
      role: "assistant",
      content: assistantMessage,
      metadata: { documentMap: sess.documentMap }
    });
    sess.history = sess.conv_chat; // Maintain backward compatibility

    await openai.conversations.items.create(sess.conversationId_chat, {
      items: [{ role: "assistant", content: assistantMessage }]
    });

    await openai.conversations.items.create(sess.conversationId_eval, {
      items: [{ role: "assistant", content: assistantMessage }]
    });

    log.info("CHAT", `assistant (intro) ${log.preview(assistantMessage, 120)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    // Update state
    sess.currentPhase = 'interviewing';

    res.json({ ok: true, file_ref: fileRef, assistant: assistantMessage });
  } catch (error) {
    log.error("UPLOAD", `failed: ${error.message}`);
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

  // ===== TURN DYNAMICS PROTOCOL =====
  // 1. Student responds - store in both conversations
  sess.conv_chat.push({ role: "user", content: message });
  sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
  sess.history = sess.conv_chat; // Maintain backward compatibility

  if (!sess.conversationId_chat || !sess.conversationId_eval) {
    return res.status(500).json({ error: "Sessão sem conversations válidas" });
  }

  try {
    await openai.conversations.items.create(sess.conversationId_chat, {
      items: [{ role: "user", content: message }]
    });

    await openai.conversations.items.create(sess.conversationId_eval, {
      items: [{ role: "user", content: message }]
    });

    log.info("CHAT", `user #${sess.questionCount + 1} ${log.preview(message, 140)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    // 2. Run evaluators (internal analysis)
    log.info("TURN", `q#${sess.questionCount + 1} evaluators=Comprehension,Clarification (parallel)`);
    const signals = await runEvaluators(sess, message);
    log.debug("TURN", `${signals.length} signals generated`);

    // 3. Orchestrator decides next action based on signals
    const decision = await orchestrateNextAction(sess, signals);
    log.info("ORCH", `decision=${decision.action}`);

    // 4. Generate appropriate response
    let assistantResponse;

    if (decision.action === 'followup') {
      // Use suggested question from evaluators
      assistantResponse = decision.question;
    } else if (decision.action === 'continue') {
      // Generate new question via LLM
      assistantResponse = await generateNextQuestion(sess);
    } else if (decision.action === 'finalize') {
      // Signal that interview is complete
      assistantResponse = "Obrigado pelas respostas. Acredito que já tenho informações suficientes para avaliar. Use o botão 'Finalizar' quando estiver pronto.";
      sess.currentPhase = 'finalizing';
    } else {
      // Default fallback
      assistantResponse = await generateNextQuestion(sess);
    }

    // 5. Store response in both conversations
    sess.conv_chat.push({ role: "assistant", content: assistantResponse });
    sess.conv_eval.push({
      role: "assistant",
      content: assistantResponse,
      metadata: { decision, timestamp: Date.now() }
    });
    sess.history = sess.conv_chat;

    await openai.conversations.items.create(sess.conversationId_chat, {
      items: [{ role: "assistant", content: assistantResponse }]
    });

    await openai.conversations.items.create(sess.conversationId_eval, {
      items: [{ role: "assistant", content: assistantResponse }]
    });

    log.info("CHAT", `assistant ${log.preview(assistantResponse, 140)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    sess.questionCount++;

    res.json({ assistant: assistantResponse });
  } catch (error) {
    log.error("CHAT", `failed: ${error.message}`);
    res.status(500).json({ error: "Erro ao processar mensagem" });
  }
});

// 4) finalizar (consolidação baseada em avaliadores)
app.post("/finalize", async (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  try {
    log.info("FINAL", `start session=${sessionId} signals=${sess.evaluationSignals.length} questions=${sess.questionCount}`);

    // Consolidate all evaluation signals
    const allSignals = sess.evaluationSignals;

    // Calculate rubric-based scores
    const rubricScores = await calculateRubricScores(sess, allSignals);

    // Generate final report
    const report = generateFinalReport(sess, rubricScores);

    log.info("FINAL", `scores C1=${report.breakdown.C1_compreensao} C2=${report.breakdown.C2_metodologia} C3=${report.breakdown.C3_parametros} total=${report.score_total}`);

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

app.listen(PORT, "0.0.0.0", () => {
  if (!process.env.OPENAI_API_KEY) {
    log.warn("BOOT", "OPENAI_API_KEY ausente no .env");
  }
  log.info("BOOT", `server listening http://0.0.0.0:${PORT} log_level=${log.level} model=${OPENAI_MODEL}`);
});

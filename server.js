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
import { ScopeClarificationAgent } from "./agents/ScopeClarificationAgent.js";
import { OffTopicRedirectAgent } from "./agents/OffTopicRedirectAgent.js";
import { MetaInterventionAgent } from "./agents/MetaInterventionAgent.js";
import { QuestionRelevanceAgent } from "./agents/QuestionRelevanceAgent.js";
import { AnswerSufficiencyAgent } from "./agents/AnswerSufficiencyAgent.js";
import { IntroductionAgent } from "./agents/IntroductionAgent.js";
import { ConfigAssistantAgent } from "./agents/ConfigAssistantAgent.js";
import { EnunciadoCoherenceAgent } from "./agents/EnunciadoCoherenceAgent.js";
import { pickPersona } from "./lib/personas.js";
import {
  sessionMiddleware,
  seedInitialUsers,
  seedInterviewerTemplates,
  loginHandler,
  logoutHandler,
  meHandler,
  listUsers,
  createUser,
  deleteUser,
  changeOwnPassword,
} from "./auth.js";
import {
  newToken,
  requireAdmin,
  requireWorkToken,
  requireSubmissionToken,
  requireWithinBudget,
  sanitizeLabel,
  PROJECT_ROOT,
} from "./lib/middleware.js";
import { renderInterviewPrompt, parseQuestionsJSON } from "./lib/interviewPrompt.js";
import { runMigrations } from "./lib/migrations.js";
import { transcribeAudio, synthesizeSpeech, AudioCache } from "./lib/audio.js";
import { getAudioDurationSeconds } from "./lib/audioMeta.js";
import { VOICES, isValidVoice } from "./config/voices.js";
import {
  loadPricing,
  validatePricingCoverage,
  getDefaultWorkBudgetUsd,
  meteredResponses,
  meteredStt,
  meteredTts,
  getWorkBalance,
  isWorkBudgetExceeded,
} from "./lib/billing.js";
import {
  writeConversationLog,
  deleteConversationLog,
} from "./lib/conversationLog.js";
import * as db from "./lib/db.js";
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
// Single source of truth: config/policy.yaml
// ============================================================================
const policy = loadPolicy();
const PRINCIPAL_REASONING_MODEL = policy?.models?.principal_reasoning_model;
if (!PRINCIPAL_REASONING_MODEL || typeof PRINCIPAL_REASONING_MODEL !== "string") {
  throw new Error("config/policy.yaml must define models.principal_reasoning_model");
}
const FAST_MODEL = policy?.models?.fast_model;
if (!FAST_MODEL || typeof FAST_MODEL !== "string") {
  throw new Error("config/policy.yaml must define models.fast_model");
}
const STT_MODEL = policy?.models?.stt_model;
if (!STT_MODEL || typeof STT_MODEL !== "string") {
  throw new Error("config/policy.yaml must define models.stt_model");
}
const TTS_MODEL = policy?.models?.tts_model;
if (!TTS_MODEL || typeof TTS_MODEL !== "string") {
  throw new Error("config/policy.yaml must define models.tts_model");
}
const TRIAGE_THRESHOLD = Number(policy?.triage?.intensity_threshold ?? 6);

log.info("CONFIG", `principal_reasoning_model=${PRINCIPAL_REASONING_MODEL} fast_model=${FAST_MODEL} stt_model=${STT_MODEL} tts_model=${TTS_MODEL} triage_threshold=${TRIAGE_THRESHOLD}`);

// Pricing — fonte única de verdade em config/pricing.yaml. Fail-fast se algum
// modelo declarado em policy.yaml não tiver entrada de preço.
loadPricing();
validatePricingCoverage({
  textModels: [PRINCIPAL_REASONING_MODEL, FAST_MODEL],
  sttModels: [STT_MODEL],
  ttsModels: [TTS_MODEL],
});
const DEFAULT_WORK_BUDGET_USD = getDefaultWorkBudgetUsd();
log.info("CONFIG", `default_work_budget_usd=$${DEFAULT_WORK_BUDGET_USD.toFixed(2)}`);

// Fixed for now; becomes configurable later.
const INTERVIEW_QUESTION_COUNT = 10;

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

function loadPolicy() {
  const cfgDir = path.join(__dirname, "config");
  const policyPath = path.join(cfgDir, "policy.yaml");
  const policyText = fs.readFileSync(policyPath, "utf-8");
  return yaml.load(policyText) || {};
}

function loadSystemPrompt() {
  const cfgDir = path.join(__dirname, "config");
  const systemPrompt = fs.readFileSync(path.join(cfgDir, "system_prompt.txt"), "utf-8");
  return systemPrompt;
}

let _interviewTemplateCache = null;
function loadInterviewPromptTemplate() {
  if (_interviewTemplateCache == null) {
    _interviewTemplateCache = fs.readFileSync(
      path.join(__dirname, "config", "interview_prompt_template.txt"),
      "utf-8"
    );
  }
  return _interviewTemplateCache;
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

// Build a turn object from a plan question (answer/answered_at filled later).
function turnFromPlanQuestion(index, q) {
  return {
    index,
    question: q?.question ?? "",
    rationale: q?.rationale ?? null,
    answer: null,
    asked_at: new Date().toISOString(),
    answered_at: null,
    question_metadata: {
      id: q?.id ?? null,
      objectives: q?.objectives ?? [],
      concerns: q?.concerns ?? [],
      decision_criteria: q?.decision_criteria ?? [],
      information_needs: q?.information_needs ?? [],
      evaluation_mode: q?.evaluation_mode ?? [],
    },
  };
}

// Serialize the professor-facing conversation log from the live session.
function buildConversationLogPayload(sess, workToken, subToken, studentLabel) {
  return {
    submission_token: subToken,
    work_token: workToken,
    student_label: studentLabel,
    interviewer_persona: sess.interviewerPersona ?? null,
    intro: {
      messages: sess.introLog ?? [],
      transitioned_at: sess.introTransitionedAt ?? null,
    },
    started_at: sess.conversationStartedAt ?? null,
    updated_at: new Date().toISOString(),
    completed: !!sess.conversationCompleted,
    document_map: sess.documentMap ?? null,
    turns: sess.turnLog ?? [],
    skipped_questions: sess.skippedQuestions ?? [],
  };
}

// Best-effort persistence. A log write failure must never abort the interview.
async function persistConversationLog(sess, submissionId, workToken, subToken, studentLabel) {
  try {
    const payload = buildConversationLogPayload(sess, workToken, subToken, studentLabel);
    await writeConversationLog(submissionId, payload);
  } catch (err) {
    log.error("LOG", `persist conversation failed submission=${subToken}: ${err.message}`);
  }
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
const mapBuilderAgent = new MapBuilderAgent(openai, PRINCIPAL_REASONING_MODEL);
const comprehensionEvaluator = new ComprehensionEvaluatorAgent(openai, PRINCIPAL_REASONING_MODEL);
const clarificationEvaluator = new ClarificationEvaluatorAgent(openai, PRINCIPAL_REASONING_MODEL);
const scopeClarificationAgent = new ScopeClarificationAgent(openai, FAST_MODEL);
const offTopicRedirectAgent = new OffTopicRedirectAgent(openai, FAST_MODEL);
const metaInterventionAgent = new MetaInterventionAgent(openai, FAST_MODEL);
const questionRelevanceAgent = new QuestionRelevanceAgent(openai, FAST_MODEL);
const answerSufficiencyAgent = new AnswerSufficiencyAgent(openai, PRINCIPAL_REASONING_MODEL);
const introductionAgent = new IntroductionAgent(openai, FAST_MODEL);
const configAssistantAgent = new ConfigAssistantAgent(openai, FAST_MODEL);
const enunciadoCoherenceAgent = new EnunciadoCoherenceAgent(openai, PRINCIPAL_REASONING_MODEL);

// Helper para construir o contexto de cobrança a partir de uma sessão. Os
// agentes recebem `meterCtx` no último parâmetro e o repassam ao
// meteredResponses() em lib/billing.js, que registra o custo no work_token.
function sessionMeterCtx(sess) {
  if (!sess) return null;
  return { workId: sess.workId ?? null, submissionId: sess.submissionId ?? null };
}

// Pré-processamento que roda em background no /upload, em paralelo com a
// saudação: PDF do aluno no DB, uploads para a OpenAI, vector store,
// document map e plano de entrevista. Atualiza `sess.interviewPlan` etc.
//
// Cada etapa envolvida em uma "step" rotulada para que o erro identifique
// exatamente o que falhou. A promessa REJEITA em caso de falha (não usamos
// `.catch` engolidor) — quem aguarda recebe a causa raiz. Pode ser invocada
// novamente em retry usando `sess.preparationInputs` (o handler de chat
// dispara um retry quando a primeira execução falhou).
function startInterviewPreparation(sess) {
  const params = sess.preparationInputs;
  if (!params) throw new Error("startInterviewPreparation: missing preparationInputs");
  sess.interviewPreparationError = null;
  sess.interviewPreparation = (async () => {
    try {
      log.info("PREP", `step=upload start submission=${params.token}`);
      const [, studentFile, enunciadoFile] = await Promise.all([
        db.setStudentPdf(params.submissionId, params.studentBuffer, params.studentFilename),
        openai.files.create({
          file: await OpenAI.toFile(params.studentBuffer, params.studentFilename),
          purpose: "user_data",
        }),
        openai.files.create({
          file: await OpenAI.toFile(params.enunciadoBlob.pdf, params.enunciadoBlob.filename || "enunciado.pdf"),
          purpose: "user_data",
        }),
      ]).catch(err => { throw new Error(`step=upload failed: ${err.message}`); });
      sess.openaiFileId = studentFile.id;
      log.info("PREP", `step=upload ok student=${studentFile.id} enunciado=${enunciadoFile.id}`);

      log.info("PREP", "step=parallel(vector_store,document_map,plan) start");
      const settled = await Promise.allSettled([
        createVectorStoreWithFile(studentFile.id, params.token),
        mapBuilderAgent.generateDocumentMap(sess.conversationId_eval, studentFile.id, params.meterCtx),
        log.span("UPLOAD", "interview plan responses.create", () =>
          meteredResponses(
            { ...params.meterCtx, agentLabel: "UPLOAD:interview_plan", model: PRINCIPAL_REASONING_MODEL },
            () => openai.responses.create({
              model: PRINCIPAL_REASONING_MODEL,
              instructions: params.renderedPrompt,
              input: [{
                role: "user",
                content: [
                  { type: "input_text", text: "Enunciado do trabalho e trabalho do estudante em anexo. Gere o JSON solicitado." },
                  { type: "input_file", file_id: enunciadoFile.id },
                  { type: "input_file", file_id: studentFile.id },
                ],
              }],
            })
          )
        ),
      ]);
      const stepLabels = ["vector_store", "document_map", "plan"];
      const failures = settled
        .map((r, i) => r.status === "rejected" ? `${stepLabels[i]}: ${r.reason?.message ?? r.reason}` : null)
        .filter(Boolean);
      if (failures.length > 0) {
        throw new Error(`step=parallel failed (${failures.join(" | ")})`);
      }
      const [vsRes, mapRes, planRes] = settled;
      sess.vectorStoreId = vsRes.value;
      sess.documentMap = mapRes.value;
      const planResp = planRes.value;
      log.info("PREP", `step=parallel ok vector_store=${sess.vectorStoreId}`);

      try {
        await openai.conversations.items.create(sess.conversationId_eval, {
          items: [{ role: "developer", content: `[DOCUMENT_MAP] ${JSON.stringify(sess.documentMap, null, 2)}` }],
        });
        await logLastConvItem(sess.conversationId_eval, "CONV:eval");
      } catch (err) {
        // Conversation log remoto não é fatal — só registra.
        log.error("PREP", `remote eval write (document_map) failed: ${err.message}`);
      }

      let plan;
      try {
        plan = parseQuestionsJSON(planResp.output_text || "");
      } catch (err) {
        log.error("PREP", `step=parse_plan failed: ${err.message}`);
        log.error("PREP", `raw plan output: ${planResp.output_text}`);
        throw new Error(`step=parse_plan failed: ${err.message}`);
      }
      const firstQuestion = plan?.questions?.[0]?.question;
      if (!firstQuestion || typeof firstQuestion !== "string") {
        throw new Error("step=validate_plan failed: plano sem primeira pergunta válida");
      }
      log.info("INTERVIEW_PLAN", `submission=${params.token} questions=${plan?.questions?.length ?? 0}`);
      log.info("INTERVIEW_PLAN", `full plan:\n${JSON.stringify(plan, null, 2)}`);
      sess.interviewPlan = plan;
      log.info("PREP", `done submission=${params.token}`);
    } catch (err) {
      log.error("PREP", `prep failed submission=${params.token}: ${err.message}`);
      sess.interviewPreparationError = err;
      throw err;
    }
  })();
  // .catch silencioso para evitar UnhandledPromiseRejection — quem realmente
  // precisa do erro chama `await sess.interviewPreparation` num try/catch.
  sess.interviewPreparation.catch(() => {});
}

const INTRO_TURN_CAP = 3;

// Cap on consecutive skips by the relevance agent. With a 10-question plan
// this leaves headroom; if it ever pegs, log and force the next ask.
const MAX_RELEVANCE_SKIPS = 8;

// Tie-break order when two triage agents return the same max intensity.
// Rationale: meta is the most distinctive indicator (system malfunction vs
// on-topic confusion), scope clarification should precede off-topic redirect
// so we don't push a confused student "back" before clarifying.
const TRIAGE_PRIORITY = ["meta", "scope_clarification", "off_topic_redirect"];

function pickTriageWinner(results) {
  let best = null;
  for (const r of results) {
    if (r.intensity < TRIAGE_THRESHOLD) continue;
    if (!best) { best = r; continue; }
    if (r.intensity > best.intensity) { best = r; continue; }
    if (r.intensity === best.intensity &&
        TRIAGE_PRIORITY.indexOf(r.type) < TRIAGE_PRIORITY.indexOf(best.type)) {
      best = r;
    }
  }
  return best;
}

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

  const meterCtx = sessionMeterCtx(session);
  // Run both evaluator agents in parallel
  const [comprehensionSignal, clarificationSignal] = await Promise.all([
    comprehensionEvaluator.evaluate(
      session.conversationId_eval,
      session.vectorStoreId,
      session.documentMap,
      studentResponse,
      meterCtx
    ),
    clarificationEvaluator.evaluate(
      session.conversationId_eval,
      session.vectorStoreId,
      session.documentMap,
      studentResponse,
      meterCtx
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
      model: PRINCIPAL_REASONING_MODEL,
      instructions: prompt,
      tools,
      input
    };

    log.prompt("QUESTION_GEN", prompt);
    const response = await log.span("QUESTION_GEN", "responses.create", () =>
      meteredResponses(
        { ...sessionMeterCtx(session), agentLabel: "QUESTION_GEN", model: PRINCIPAL_REASONING_MODEL },
        () => openai.responses.create(payload)
      )
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
app.get("/w/:workToken/s/:subToken", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "conversation.html"));
});
app.get("/s/:submissionToken", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "student.html"));
});

// ============================================================================
// MULTER: in-memory storage. PDFs flow Buffer -> DB (BYTEA) and Buffer ->
// OpenAI Files via OpenAI.toFile, never touching disk.
// ============================================================================
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MB
const enunciadoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT_BYTES },
});
const studentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT_BYTES },
});
// Áudio do aluno: limite menor (mensagens de voz raramente passam de 1-2 min).
const AUDIO_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_UPLOAD_LIMIT_BYTES },
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================
app.get("/admin/works", requireAdmin, async (_req, res) => {
  try {
    const works = await db.listWorks();
    res.json({ works });
  } catch (err) {
    log.error("ADMIN", `list works failed: ${err.message}`);
    res.status(500).json({ error: "failed to list works" });
  }
});

app.post("/admin/works", requireAdmin, async (req, res) => {
  let name;
  try { name = sanitizeLabel(req.body?.name); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  // Orçamento opcional na criação; se ausente, usa o default de pricing.yaml.
  let budget = DEFAULT_WORK_BUDGET_USD;
  if (req.body?.budget_usd !== undefined && req.body?.budget_usd !== null && req.body?.budget_usd !== "") {
    const parsed = Number(req.body.budget_usd);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return res.status(400).json({ error: "budget_usd must be a non-negative number" });
    }
    budget = parsed;
  }
  try {
    const work = await db.createWork(name, budget);
    log.info("ADMIN", `work created token=${work.work_token} name="${work.name}" budget=$${Number(work.budget_usd).toFixed(2)} by=${req.session.user.username}`);
    res.json({ work });
  } catch (err) {
    log.error("ADMIN", `create work failed: ${err.message}`);
    res.status(500).json({ error: "failed to create work" });
  }
});

app.patch("/admin/works/:workToken/budget", requireAdmin, express.json({ limit: "8kb" }), async (req, res) => {
  const workToken = String(req.params.workToken || "").toLowerCase();
  const parsed = Number(req.body?.budget_usd);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return res.status(400).json({ error: "budget_usd must be a non-negative number" });
  }
  try {
    const work = await db.getWorkByToken(workToken);
    if (!work) return res.status(404).json({ error: "work not found" });
    const updated = await db.updateWorkBudget(work.id, parsed);
    log.info("ADMIN", `work budget updated token=${workToken} budget=$${Number(updated.budget_usd).toFixed(2)} by=${req.session.user.username}`);
    res.json({ ok: true, budget_usd: updated.budget_usd, spent_usd: updated.spent_usd });
  } catch (err) {
    log.error("ADMIN", `update work budget failed: ${err.message}`);
    res.status(500).json({ error: "failed to update budget" });
  }
});

// Defaults expostos para o frontend admin pré-preencher campos.
app.get("/admin/defaults", requireAdmin, (_req, res) => {
  res.json({ default_work_budget_usd: DEFAULT_WORK_BUDGET_USD });
});

// ---- User management (every authenticated user is an admin) ----
app.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (err) {
    log.error("ADMIN", `list users failed: ${err.message}`);
    res.status(500).json({ error: "failed to list users" });
  }
});

app.post("/admin/users", requireAdmin, async (req, res) => {
  try {
    const user = await createUser(req.body?.username, req.body?.password);
    log.info("ADMIN", `user created username="${user.username}" by=${req.session.user.username}`);
    res.json({ user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    log.error("ADMIN", `create user failed: ${err.message}`);
    res.status(500).json({ error: "failed to create user" });
  }
});

app.post("/admin/users/me/password", requireAdmin, async (req, res) => {
  try {
    await changeOwnPassword(
      req.session.user.id,
      req.body?.currentPassword,
      req.body?.newPassword
    );
    log.info("ADMIN", `user password changed username="${req.session.user.username}"`);
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    log.error("ADMIN", `change password failed: ${err.message}`);
    res.status(500).json({ error: "failed to change password" });
  }
});

app.delete("/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const username = await deleteUser(req.params.id, req.session.user.id);
    log.info("ADMIN", `user deleted username="${username}" by=${req.session.user.username}`);
    res.json({ ok: true, deleted: username });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    log.error("ADMIN", `delete user failed: ${err.message}`);
    res.status(500).json({ error: "failed to delete user" });
  }
});

// ============================================================================
// PROFESSOR ROUTES (bearer auth via work_token)
// ============================================================================
app.get("/w/:workToken/info", requireWorkToken, async (req, res) => {
  try {
    const submissions = await db.listSubmissionsForWork(req.work.id);
    const balance = await getWorkBalance(req.work.id);
    res.json({
      work: {
        name: req.work.name,
        has_enunciado: !!req.work.assignment_pdf,
        has_interviewer: !!req.work.has_interviewer,
        interaction_mode: req.work.interaction_mode,
        voice: req.work.voice,
        budget_usd: balance?.budget_usd ?? 0,
        spent_usd: balance?.spent_usd ?? 0,
        remaining_usd: balance?.remaining_usd ?? 0,
        percent_used: balance?.percent_used ?? 100,
      },
      submissions,
    });
  } catch (err) {
    log.error("WORK", `info failed: ${err.message}`);
    res.status(500).json({ error: "failed to load work info" });
  }
});

// ---- Modo de interação (texto vs áudio) e voz ----

app.get("/w/:workToken/voices", requireWorkToken, (req, res) => {
  res.json({ voices: VOICES.map(v => ({ id: v.id, label: v.label, gender: v.gender })) });
});

const PREVIEW_DEFAULT_TEXT = "Olá, sou seu entrevistador. Vamos começar?";
const previewCache = new AudioCache(20); // chave: voiceId|textHash

function hashText(s) {
  // Hash leve, suficiente pra chave de cache em memória.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

app.post("/w/:workToken/voices/preview", requireWorkToken, requireWithinBudget, express.json({ limit: "16kb" }), async (req, res) => {
  const voiceId = String(req.body?.voiceId ?? "");
  const text = String(req.body?.text ?? PREVIEW_DEFAULT_TEXT).slice(0, 200);
  if (!isValidVoice(voiceId)) return res.status(400).json({ error: "voz inválida" });

  const cacheKey = `${voiceId}|${hashText(text)}`;
  let buffer = previewCache.get(cacheKey);
  if (!buffer) {
    try {
      buffer = await meteredTts(
        { workId: req.work.id, model: TTS_MODEL, inputText: text },
        () => synthesizeSpeech(openai, TTS_MODEL, text, voiceId)
      );
      previewCache.set(cacheKey, buffer);
    } catch (err) {
      log.error("VOICES", `preview failed: ${err.message}`);
      return res.status(500).json({ error: "falha ao gerar prévia", detail: err.message });
    }
  }
  res.type("audio/mpeg");
  res.send(buffer);
});

app.post("/w/:workToken/interaction", requireWorkToken, express.json({ limit: "16kb" }), async (req, res) => {
  const mode = String(req.body?.mode ?? "");
  const voice = req.body?.voice ? String(req.body.voice) : null;

  if (mode !== "text" && mode !== "audio") {
    return res.status(400).json({ error: "mode deve ser 'text' ou 'audio'" });
  }
  if (mode === "audio" && !isValidVoice(voice)) {
    return res.status(400).json({ error: "voz inválida ou ausente para o modo áudio" });
  }

  try {
    await db.setInteractionMode(req.work.id, mode, voice);
    log.info("WORK", `interaction mode=${mode} voice=${voice ?? "-"} work=${req.work.work_token}`);
    res.json({ ok: true, interaction_mode: mode, voice: mode === "audio" ? voice : null });
  } catch (err) {
    log.error("WORK", `set interaction failed: ${err.message}`);
    res.status(500).json({ error: "falha ao salvar modo de interação", detail: err.message });
  }
});

app.get("/w/:workToken/submissions/:subToken/conversation", requireWorkToken, async (req, res) => {
  const subToken = String(req.params.subToken || "").toLowerCase();
  try {
    const found = await db.findSubmissionByToken(subToken);
    if (!found || found.work_id !== req.work.id) {
      return res.status(404).json({ error: "submission not found" });
    }
    let conversation = null;
    const text = await db.getConversationJson(found.id);
    if (text) {
      try { conversation = JSON.parse(text); }
      catch (err) {
        log.error("WORK", `conversation parse failed submission=${subToken}: ${err.message}`);
        return res.status(500).json({ error: "failed to read conversation" });
      }
    }
    res.json({
      work: { work_token: req.work.work_token, name: req.work.name },
      submission: { submission_token: subToken, student_label: found.student_label, status: found.status },
      conversation,
    });
  } catch (err) {
    log.error("WORK", `conversation lookup failed submission=${subToken}: ${err.message}`);
    res.status(500).json({ error: "failed to read conversation" });
  }
});

// ---- Interviewer templates (shared) ----
app.get("/interviewers/templates", async (_req, res) => {
  try {
    const templates = await db.listInterviewerTemplates();
    res.json({ templates });
  } catch (err) {
    log.error("TPL", `list failed: ${err.message}`);
    res.status(500).json({ error: "failed to list templates" });
  }
});

app.get("/interviewers/templates/:filename", async (req, res) => {
  const filename = String(req.params.filename);
  try {
    const content = await db.getInterviewerTemplate(filename);
    if (content == null) return res.status(404).json({ error: "template not found" });
    res.type("text/plain").send(content);
  } catch (err) {
    log.error("TPL", `read failed: ${err.message}`);
    res.status(500).json({ error: "failed to read template" });
  }
});

// ---- Per-work interviewer YAML ----
app.get("/w/:workToken/interviewer", requireWorkToken, async (req, res) => {
  try {
    const yamlText = await db.getInterviewerYaml(req.work.id);
    res.json({ yaml: yamlText ?? null });
  } catch (err) {
    log.error("WORK", `interviewer read failed: ${err.message}`);
    res.status(500).json({ error: "failed to read interviewer" });
  }
});

app.post("/w/:workToken/interviewer", requireWorkToken, express.json({ limit: "256kb" }), async (req, res) => {
  const content = String(req.body?.yaml ?? "");
  if (!content.trim()) return res.status(400).json({ error: "yaml content required" });
  try {
    yaml.load(content);
  } catch (err) {
    return res.status(400).json({ error: "invalid YAML", detail: err.message });
  }
  try {
    await db.setInterviewerYaml(req.work.id, content);
    log.info("WORK", `interviewer saved work=${req.work.work_token} bytes=${content.length}`);
    res.json({ ok: true });
  } catch (err) {
    log.error("WORK", `interviewer save failed: ${err.message}`);
    res.status(500).json({ error: "failed to save interviewer" });
  }
});

const INTERVIEWER_ADAPT_INSTRUCTIONS = `Você adapta prompts de entrevistador acadêmico. Receberá:
1) Um YAML com a definição genérica de um entrevistador (agente, cenário, conversa).
2) O enunciado de um trabalho específico, em PDF anexado.

Produza um NOVO YAML que preserve exatamente a mesma estrutura de chaves
e hierarquia do genérico, mas com valores textuais especializados ao trabalho
descrito no enunciado. Os valores passam a referenciar conceitos, termos,
objetivos, métodos e entregáveis concretos do enunciado.

Regras rígidas:
- NÃO invente informações ausentes do enunciado.
- NÃO adicione, remova ou renomeie chaves.
- Mantenha o idioma do YAML genérico.
- Listas mantêm aproximadamente o mesmo número de itens; reescreva cada
  item para soar específico ao trabalho.
- Onde o YAML genérico usar expressões abstratas ("o trabalho", "o aluno
  deve"), substitua por formulações ancoradas no enunciado.
- Campos inerentemente genéricos (ex.: interaction_style: "investigativo")
  podem ser mantidos se não houver base no enunciado para especializá-los.
- O campo scenario.case_context.summary deve descrever, em 1–2 frases, o
  caso concreto entregue pelo aluno conforme o enunciado.

Responda APENAS com o YAML adaptado. Nada antes, nada depois. Sem cercas
de código markdown.`;

function stripYamlFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

app.post("/w/:workToken/interviewer/adapt", requireWorkToken, requireWithinBudget, express.json({ limit: "256kb" }), async (req, res) => {
  const genericYaml = String(req.body?.yaml ?? "");
  if (!genericYaml.trim()) return res.status(400).json({ error: "yaml content required" });
  try {
    yaml.load(genericYaml);
  } catch (err) {
    return res.status(400).json({ error: "invalid input YAML", detail: err.message });
  }

  const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
  if (!enunciadoBlob) {
    return res.status(400).json({ error: "envie o enunciado do trabalho antes de adaptar" });
  }

  try {
    log.info("INTERVIEWER_ADAPT", `start work=${req.work.work_token} bytes=${genericYaml.length}`);
    const fileUpload = await openai.files.create({
      file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
      purpose: "user_data",
    });
    log.info("INTERVIEWER_ADAPT", `uploaded enunciado file=${fileUpload.id}`);

    const response = await log.span("INTERVIEWER_ADAPT", "responses.create", () =>
      meteredResponses(
        { workId: req.work.id, agentLabel: "INTERVIEWER_ADAPT", model: PRINCIPAL_REASONING_MODEL },
        () => openai.responses.create({
          model: PRINCIPAL_REASONING_MODEL,
          instructions: INTERVIEWER_ADAPT_INSTRUCTIONS,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: `YAML genérico:\n\n${genericYaml}\n\nEnunciado em anexo. Gere o YAML adaptado.` },
              { type: "input_file", file_id: fileUpload.id },
            ],
          }],
        })
      )
    );

    const adaptedYaml = stripYamlFence(response.output_text || "");
    if (!adaptedYaml) {
      return res.status(502).json({ error: "o modelo não retornou YAML" });
    }
    try {
      yaml.load(adaptedYaml);
    } catch (err) {
      log.warn("INTERVIEWER_ADAPT", `returned YAML did not parse: ${err.message}`);
      return res.status(502).json({ error: "o modelo retornou YAML inválido", yaml: adaptedYaml, detail: err.message });
    }
    log.info("INTERVIEWER_ADAPT", `ok work=${req.work.work_token} out_bytes=${adaptedYaml.length}`);
    res.json({ yaml: adaptedYaml });
  } catch (err) {
    log.error("INTERVIEWER_ADAPT", `failed: ${err.message}`);
    res.status(500).json({ error: "falha ao adaptar o interviewer", detail: err.message });
  }
});

app.get("/w/:workToken/enunciado", requireWorkToken, async (req, res) => {
  try {
    const blob = await db.getEnunciadoBlob(req.work.id);
    if (!blob) return res.status(404).json({ error: "enunciado not uploaded" });
    res.type("application/pdf");
    if (blob.filename) {
      res.set("Content-Disposition", `inline; filename="${encodeURIComponent(blob.filename)}"`);
    }
    res.send(blob.pdf);
  } catch (err) {
    log.error("WORK", `enunciado read failed: ${err.message}`);
    res.status(500).json({ error: "failed to read enunciado" });
  }
});

app.post("/w/:workToken/enunciado", requireWorkToken, enunciadoUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  try {
    await db.setEnunciadoBlob(req.work.id, req.file.buffer, req.file.originalname);
    // Cache de coerência fica obsoleto quando o PDF é substituído.
    await db.clearCoherenceCache(req.work.id);
    log.info("WORK", `enunciado uploaded work=${req.work.work_token} bytes=${req.file.size} name=${req.file.originalname}`);
    res.json({ ok: true });
  } catch (err) {
    log.error("WORK", `enunciado save failed: ${err.message}`);
    res.status(500).json({ error: "failed to save enunciado" });
  }
});

// ---- Coerência do enunciado (assistente de configuração) ----
// Avalia se o enunciado está bem encaixado no processo de entrevista.
// NUNCA avalia a qualidade pedagógica/técnica do trabalho em si.
// Resultado é cacheado em works.enunciado_coherence_json até o PDF ser substituído.
app.post("/w/:workToken/enunciado/coherence", requireWorkToken, requireWithinBudget, async (req, res) => {
  const force = String(req.query?.force ?? "").toLowerCase() === "true";

  try {
    if (!force) {
      const cached = await db.getCoherenceCache(req.work.id);
      if (cached) {
        log.info("COHERENCE", `cache hit work=${req.work.work_token}`);
        return res.json({ ...cached, cached: true });
      }
    }

    const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
    if (!enunciadoBlob) {
      return res.status(400).json({ error: "envie o enunciado do trabalho antes de avaliar" });
    }

    log.info("COHERENCE", `start work=${req.work.work_token} force=${force}`);
    const fileUpload = await openai.files.create({
      file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
      purpose: "user_data",
    });
    log.info("COHERENCE", `uploaded enunciado file=${fileUpload.id}`);

    const report = await enunciadoCoherenceAgent.evaluate({
      openaiFileId: fileUpload.id,
      meterCtx: { workId: req.work.id },
    });
    await db.setCoherenceCache(req.work.id, report);
    log.info("COHERENCE", `ok work=${req.work.work_token} overall=${report.overall}`);
    res.json({ ...report, cached: false });
  } catch (err) {
    log.error("COHERENCE", `failed: ${err.message}`);
    res.status(500).json({ error: "falha ao avaliar coerência do enunciado", detail: err.message });
  }
});

// ---- Chat ephemero do assistente de configuração ----
// Histórico vem do cliente em cada turno. Sem persistência server-side e sem
// tocar a Conversations API (ver CLAUDE.md). Modelo: fast_model.
app.post("/w/:workToken/config-chat", requireWorkToken, requireWithinBudget, express.json({ limit: "256kb" }), async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "message required" });

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content }))
    .slice(-30); // bound por segurança

  try {
    const stateBlock = await buildConfigStateBlock(req.work);
    const result = await configAssistantAgent.evaluate({
      history,
      message,
      stateBlock,
      meterCtx: { workId: req.work.id },
    });
    res.json(result);
  } catch (err) {
    log.error("CONFIG_CHAT", `failed: ${err.message}`);
    res.status(500).json({ error: "falha no assistente de configuração", detail: err.message });
  }
});

async function buildConfigStateBlock(work) {
  const coherence = await db.getCoherenceCache(work.id);
  const interviewerYaml = await db.getInterviewerYaml(work.id);

  let originLine = "nenhum (professor ainda não salvou)";
  if (interviewerYaml) {
    const matchedTemplate = await findMatchingTemplateName(interviewerYaml);
    originLine = matchedTemplate
      ? `salvo (baseado em "${matchedTemplate}")`
      : "salvo (customizado ou adaptado — não corresponde byte-a-byte a nenhuma das 6 personas prontas)";
  }

  const header = `- Nome do trabalho: ${work.name}
- Enunciado enviado: ${work.assignment_pdf ? "sim" : "não"}
- Persona/YAML do entrevistador: ${originLine}
- Templates disponíveis: Teacher Assistant.yaml, Business Owner.yaml, Hiring Manager.yaml, Investor.yaml, Executive Sponsor.yaml, Journalist.yaml`;

  if (!coherence) {
    return `${header}
- Diagnóstico de coerência do enunciado: ainda não avaliado (você pode emitir action.type=request_assignment_check se o professor pedir avaliação)`;
  }

  const findingsBlock = (coherence.findings || []).map(f =>
    `    - ${f.criterion} [${f.status}]: ${f.comment}`
  ).join("\n");
  const personasBlock = (coherence.suggested_personas || []).map(p =>
    `    - ${p.filename} (fit=${p.fit}): ${p.reason}`
  ).join("\n");
  const fixesBlock = (coherence.fix_suggestions || []).map(s => `    - ${s}`).join("\n");

  return `${header}
- Diagnóstico de coerência do enunciado JÁ DISPONÍVEL (NÃO emita request_assignment_check de novo — comente este relatório):
    overall: ${coherence.overall}
    summary: ${coherence.summary}
  Achados por critério:
${findingsBlock || "    (nenhum)"}
  Personas sugeridas:
${personasBlock || "    (nenhuma)"}
  Sugestões de correção do enunciado:
${fixesBlock || "    (nenhuma)"}`;
}

async function findMatchingTemplateName(savedYamlText) {
  // Best-effort: identifica se o YAML salvo é byte-identical a um dos 6 templates.
  // Se não for, devolvemos null (provavelmente foi adaptado ou customizado).
  const templates = await db.listInterviewerTemplates();
  for (const t of templates) {
    const tplText = await db.getInterviewerTemplate(t.filename);
    if (tplText && tplText.trim() === savedYamlText.trim()) return t.filename;
  }
  return null;
}

app.post("/w/:workToken/submissions", requireWorkToken, async (req, res) => {
  let baseLabel;
  try { baseLabel = sanitizeLabel(req.body?.label); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const rawCount = Number(req.body?.count ?? 1);
  const count = Number.isFinite(rawCount) && rawCount > 0 && rawCount <= 50 ? Math.floor(rawCount) : 1;

  try {
    const rows = await db.createSubmissions(req.work.id, baseLabel, count);
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
    interactionMode: sess.interactionMode || "text",
    voice: sess.voice || null,
    chat: sess.conv_chat.map(m => ({ role: m.role, content: m.content })),
  };
}

// Gera TTS para um trecho do entrevistador, caches em memória, e devolve
// { audio_url } pra anexar à resposta JSON. No modo texto, retorna {} —
// nenhum custo, nenhuma chamada à OpenAI. No modo áudio, falha de TTS é
// tratada como degradação graciosa: retorna { audio_error } e o frontend
// mostra o texto como fallback.
async function attachAudio(sess, content) {
  if (!content || sess.interactionMode !== "audio") return {};
  if (!sess.voice) {
    log.warn("AUDIO", `audio mode without voice (sess=${sess.submissionToken})`);
    return { audio_error: "no_voice_configured" };
  }
  try {
    const buffer = await meteredTts(
      { ...sessionMeterCtx(sess), model: TTS_MODEL, inputText: content },
      () => synthesizeSpeech(openai, TTS_MODEL, content, sess.voice)
    );
    const turnId = String(sess.audioTurnIdCounter++);
    sess.audioCache.set(turnId, buffer);
    const durationSec = await getAudioDurationSeconds(buffer, "audio/mpeg");
    return {
      audio_url: `/s/${encodeURIComponent(sess.submissionToken)}/audio/${turnId}`,
      audio_duration_seconds: durationSec,
    };
  } catch (err) {
    log.error("AUDIO", `TTS failed: ${err.message}`);
    return { audio_error: "tts_failed" };
  }
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
      const interviewerPersona = pickPersona();
      sess = {
        systemPrompt,
        submissionToken: token,
        workToken: req.work.work_token,
        workId: req.work.id,
        submissionId: req.submission.id,
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
        interviewerPersona,
        introLog: [],
        introTransitionedAt: null,
        interviewPreparation: null,
        // Modo de interação congelado no /start. Mudança posterior na
        // configuração do trabalho não afeta sessões já iniciadas.
        interactionMode: req.work.interaction_mode || "text",
        voice: req.work.voice || null,
        audioCache: new AudioCache(10),
        audioTurnIdCounter: 0,
      };
      SESSIONS.set(token, sess);
      log.info("SUBMISSION", `start token=${token} work=${req.work.work_token} mode=${sess.interactionMode} voice=${sess.voice ?? "-"} persona=${interviewerPersona.name}/${interviewerPersona.city} chat=${chatConversation.id} eval=${evalConversation.id}`);
    } else {
      // Init defensivo para sessões anteriores ao feature de áudio.
      if (!sess.audioCache) sess.audioCache = new AudioCache(10);
      if (typeof sess.audioTurnIdCounter !== "number") sess.audioTurnIdCounter = 0;
      if (!sess.interactionMode) sess.interactionMode = "text";
      // O "freeze" do modo só vale a partir do upload do trabalho. Antes
      // disso, é seguro (e desejável) re-sincronizar com a configuração
      // atual do trabalho — assim o professor pode mudar o modo entre dois
      // acessos do aluno sem upload e o aluno pega a mudança.
      if (sess.currentPhase === "awaiting_upload") {
        sess.interactionMode = req.work.interaction_mode || "text";
        sess.voice = req.work.voice || null;
      }
      log.info("SUBMISSION", `resume token=${token} phase=${sess.currentPhase} qn=${sess.questionCount} mode=${sess.interactionMode}`);
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

app.post("/s/:submissionToken/upload", requireSubmissionToken, requireWithinBudget, studentUpload.single("file"), async (req, res) => {
  const token = req.submission.submission_token;
  if (req.submission.status === "finalized") return res.status(403).json({ error: "finalized" });
  const sess = SESSIONS.get(token);
  if (!sess) return res.status(400).json({ error: "call /start first" });
  if (!req.file) return res.status(400).json({ error: "file required" });

  const studentBuffer = req.file.buffer;
  const studentFilename = req.file.originalname;
  sess.submissionPath = studentFilename;

  // New upload = new interview attempt. Reset log state and wipe any previous
  // conversation log so the professor only ever sees the current attempt.
  sess.turnLog = [];
  sess.skippedQuestions = [];
  sess.conversationStartedAt = new Date().toISOString();
  sess.conversationCompleted = false;
  // Re-sincroniza modo de interação e voz com o estado atual do trabalho.
  // Cada upload é uma nova tentativa de entrevista — pega o modo
  // configurado AGORA. Durante a entrevista (após este upload), o modo
  // fica imutável até o próximo upload.
  sess.interactionMode = req.work.interaction_mode || "text";
  sess.voice = req.work.voice || null;
  log.info("SUBMISSION", `upload token=${token} mode=${sess.interactionMode} voice=${sess.voice ?? "-"}`);
  try { await deleteConversationLog(req.submission.id); }
  catch (err) { log.error("LOG", `delete old conversation log failed: ${err.message}`); }

  // Reads do DB em paralelo (são leves, mas não há razão para sequenciar).
  const [interviewerYamlText, enunciadoBlob] = await Promise.all([
    db.getInterviewerYaml(req.work.id),
    db.getEnunciadoBlob(req.work.id),
  ]);
  if (!interviewerYamlText) {
    return res.status(400).json({ error: "O professor ainda não configurou o entrevistador para este trabalho." });
  }
  if (!enunciadoBlob) {
    return res.status(400).json({ error: "O professor ainda não enviou o enunciado para este trabalho." });
  }

  try {
    log.info("UPLOAD", `student file=${studentFilename} bytes=${studentBuffer.length} submission=${token}`);

    sess.interviewerYamlText = interviewerYamlText;
    sess.currentPhase = "intro";
    sess.questionIndex = 1;
    const meterCtx = sessionMeterCtx(sess);

    // ESTRATÉGIA DE LATÊNCIA: o cumprimento de abertura usa apenas o YAML do
    // entrevistador e a persona — nada do upload do aluno, nada do vector
    // store. Disparamos a saudação (fast model, ~1-2s) em paralelo com TODA
    // a preparação pesada (uploads de PDF, vector store, document map, plano
    // de entrevista). O caminho crítico até o aluno ver a saudação fica em
    // O(saudação), em vez de O(uploads + vector store + saudação).
    //
    // O resultado da prep aterrissa em sess.interviewPlan/documentMap/etc;
    // se o intro chegar ao cap antes da prep terminar, o handler de chat
    // aguarda sess.interviewPreparation explicitamente.
    const renderedPrompt = renderInterviewPrompt(
      loadInterviewPromptTemplate(),
      interviewerYamlText,
      INTERVIEW_QUESTION_COUNT
    );
    log.prompt("UPLOAD:interview_plan", renderedPrompt);

    // Inputs da prep ficam guardados na sessão para permitir retry caso a
    // primeira execução em background falhe (ex.: timeout transitório de
    // rede). Sem isso, uma falha durante a fase intro deixaria o aluno preso.
    sess.preparationInputs = {
      submissionId: req.submission.id,
      studentBuffer,
      studentFilename,
      enunciadoBlob,
      renderedPrompt,
      meterCtx,
      token,
    };
    startInterviewPreparation(sess);

    // Cumprimento — disparado em paralelo com a prep pesada acima. É só esse
    // que precisa terminar para responder ao aluno.
    const greeting = await introductionAgent.evaluate({
      interviewerYamlText,
      persona: sess.interviewerPersona,
      introHistory: sess.introLog,
      studentMessage: null,
      mainReady: false,
      introTurnCount: 0,
      introTurnCap: INTRO_TURN_CAP,
      meterCtx,
    });

    // TTS antes do push para podermos persistir a duração junto com o item.
    const audio = await attachAudio(sess, greeting.message);
    const greetingEntry = {
      role: "assistant",
      content: greeting.message,
      at: new Date().toISOString(),
      audio_duration_seconds: audio.audio_duration_seconds ?? null,
    };
    sess.introLog.push(greetingEntry);
    sess.conv_chat.push({ role: "assistant", content: greeting.message });
    sess.conv_eval.push({ role: "assistant", content: greeting.message, metadata: { phase: "intro", persona: sess.interviewerPersona, timestamp: Date.now() } });
    sess.history = sess.conv_chat;

    try {
      await openai.conversations.items.create(sess.conversationId_chat, {
        items: [{ role: "assistant", content: greeting.message }],
      });
      await openai.conversations.items.create(sess.conversationId_eval, {
        items: [{ role: "assistant", content: greeting.message }],
      });
    } catch (err) {
      log.error("CHAT", `remote write (intro greeting) failed: ${err.message}`);
    }

    log.info("CHAT", `intro greeting persona=${sess.interviewerPersona.name}/${sess.interviewerPersona.city} ${log.preview(greeting.message, 120)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    await persistConversationLog(
      sess,
      req.submission.id,
      req.work.work_token,
      token,
      req.submission.student_label,
    );

    res.json({ ok: true, assistant: greeting.message, ...audio });
  } catch (error) {
    log.error("UPLOAD", `failed: ${error.message}`);
    res.status(500).json({ error: "Erro ao processar arquivo com a IA" });
  }
});

// Endpoint que serve o áudio do entrevistador a partir do cache em memória.
// Retorna 404 se o turno foi evictado (cache LRU) — frontend mostra o texto
// como fallback.
app.get("/s/:submissionToken/audio/:turnId", requireSubmissionToken, (req, res) => {
  const token = req.submission.submission_token;
  const sess = SESSIONS.get(token);
  if (!sess) return res.status(404).json({ error: "session not found" });
  const buffer = sess.audioCache?.get(String(req.params.turnId));
  if (!buffer) return res.status(404).json({ error: "audio expired or not found" });
  res.type("audio/mpeg");
  res.send(buffer);
});

app.post("/s/:submissionToken/chat", requireSubmissionToken, requireWithinBudget, audioUpload.single("audio"), async (req, res) => {
  const token = req.submission.submission_token;
  if (req.submission.status === "finalized") return res.status(403).json({ error: "finalized" });
  const sess = SESSIONS.get(token);
  if (!sess) return res.status(400).json({ error: "call /start first" });
  // O /upload move a sessão de "awaiting_upload" para "intro" e dispara
  // sess.interviewPreparation (uploads de arquivo + vector store + plan +
  // documentMap) em paralelo com a saudação. Durante intro, nada disso é
  // necessário — o IntroductionAgent só usa o YAML do entrevistador. A
  // transição para "interviewing" aguarda explicitamente a prep terminar
  // (ver mais abaixo no handler).
  if (sess.currentPhase === "awaiting_upload") {
    return res.status(400).json({ error: "envie o trabalho (PDF) antes de iniciar a conversa" });
  }

  // Coerência de modo: se a sessão é áudio, espera áudio; se é texto,
  // espera texto. Sem mistura no mesmo turno.
  const isAudioMode = sess.interactionMode === "audio";
  const hasAudio = !!req.file;
  if (isAudioMode && !hasAudio) {
    return res.status(400).json({ error: "esta entrevista está em modo áudio — envie uma gravação" });
  }
  if (!isAudioMode && hasAudio) {
    return res.status(400).json({ error: "esta entrevista está em modo texto — envie uma mensagem escrita" });
  }

  let message;
  // Duração da mensagem de voz do aluno (segundos). Em modo texto fica null.
  // Probada do buffer original antes do STT — não depende do shape do response.
  let studentAudioDurationSec = null;
  if (hasAudio) {
    try {
      studentAudioDurationSec = await getAudioDurationSeconds(
        req.file.buffer,
        req.file.mimetype || null,
      );
      const sttResult = await meteredStt(
        { ...sessionMeterCtx(sess), model: STT_MODEL },
        () => transcribeAudio(openai, STT_MODEL, req.file.buffer, req.file.originalname || "audio.webm")
      );
      message = sttResult.text;
    } catch (err) {
      log.error("CHAT", `STT failed: ${err.message}`);
      return res.status(400).json({ error: "transcription_failed", detail: "Não consegui entender o áudio. Tente gravar de novo." });
    }
  } else {
    message = (req.body?.message || "").toString();
  }
  if (!message) return res.status(400).json({ error: "empty message" });

  const persist = () => persistConversationLog(
    sess,
    req.submission.id,
    req.work.work_token,
    token,
    req.submission.student_label,
  );

  // ------------------------------------------------------------------
  // Intro phase: short social opening from the persona-bearing agent
  // while the heavy plan generation runs in background. Each turn the
  // agent decides between continuing the chitchat and transitioning to
  // the interview proper. Triage/sufficiency/relevance do not run here.
  // ------------------------------------------------------------------
  if (sess.currentPhase === "intro") {
    sess.introLog.push({
      role: "user",
      content: message,
      at: new Date().toISOString(),
      audio_duration_seconds: studentAudioDurationSec,
    });
    sess.conv_chat.push({ role: "user", content: message });
    sess.conv_eval.push({ role: "user", content: message, metadata: { phase: "intro", timestamp: Date.now() } });
    sess.history = sess.conv_chat;
    try {
      await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
      await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "user", content: message }] });
    } catch (err) {
      log.error("CHAT", `remote write (intro user) failed: ${err.message}`);
    }

    const introTurnCount = sess.introLog.filter(m => m.role === "assistant").length;
    const mainReady = !!sess.interviewPlan;

    let intro;
    try {
      intro = await introductionAgent.evaluate({
        interviewerYamlText: sess.interviewerYamlText ?? "",
        persona: sess.interviewerPersona,
        introHistory: sess.introLog.slice(0, -1),  // history without the just-pushed student message; agent receives that separately
        studentMessage: message,
        mainReady,
        introTurnCount,
        introTurnCap: INTRO_TURN_CAP,
        meterCtx: sessionMeterCtx(sess),
      });
    } catch (err) {
      log.error("AGENT:Introduction", `failed, forcing transition: ${err.message}`);
      intro = { decision: "transition", message: "Bom, vamos ao trabalho.", reason: "agent_failed" };
    }

    // Force transition when the cap is reached, regardless of the agent's call.
    if (intro.decision !== "transition" && introTurnCount >= INTRO_TURN_CAP) {
      log.info("INTRO", `cap reached (${INTRO_TURN_CAP}), forcing transition`);
      intro = { decision: "transition", message: intro.message || "Desculpe, tenho pouco tempo. Vamos ao trabalho.", reason: "cap_reached" };
    }

    if (intro.decision === "continue_intro") {
      const audio = await attachAudio(sess, intro.message);
      sess.introLog.push({
        role: "assistant",
        content: intro.message,
        at: new Date().toISOString(),
        audio_duration_seconds: audio.audio_duration_seconds ?? null,
      });
      sess.conv_chat.push({ role: "assistant", content: intro.message });
      sess.conv_eval.push({ role: "assistant", content: intro.message, metadata: { phase: "intro", timestamp: Date.now() } });
      sess.history = sess.conv_chat;
      try {
        await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: intro.message }] });
        await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: intro.message }] });
      } catch (err) {
        log.error("CHAT", `remote write (intro continue) failed: ${err.message}`);
      }
      log.info("CHAT", `intro continue ${log.preview(intro.message, 120)}`);
      await logLastConvItem(sess.conversationId_chat, "CONV:chat");
      persist();
      return res.json({ channel: "chat", assistant: intro.message, ...audio });
    }

    // Transition: garantir que o plano está pronto. Se a prep ainda está
    // rodando, esperamos. Se já falhou, tentamos uma vez de novo. Se mesmo
    // assim falhar, devolvemos o erro REAL (não a mensagem genérica) — útil
    // pra debug quando algo trava em produção.
    if (!sess.interviewPlan) {
      // Aguarda execução em curso (resolve com sucesso ou rejeita silenciosamente).
      try { await sess.interviewPreparation; }
      catch (err) { log.error("INTRO", `interviewPreparation failed: ${err.message}`); }

      // Se falhou e temos os inputs guardados, dispara uma retry em foreground.
      if (!sess.interviewPlan && sess.interviewPreparationError && sess.preparationInputs) {
        log.info("INTRO", `retrying interview preparation after failure: ${sess.interviewPreparationError.message}`);
        startInterviewPreparation(sess);
        try { await sess.interviewPreparation; }
        catch (err) { log.error("INTRO", `interviewPreparation retry failed: ${err.message}`); }
      }

      if (!sess.interviewPlan) {
        const detail = sess.interviewPreparationError?.message || "plano indisponível";
        log.error("INTRO", `transition aborted: ${detail}`);
        return res.status(500).json({
          error: "Falha ao preparar a entrevista. Tente novamente.",
          detail,
        });
      }
    }

    const firstPlanQuestion = sess.interviewPlan.questions[0];
    const combined = `${intro.message}\n\n${firstPlanQuestion.question}`;

    // TTS antes do push para podermos persistir a duração no turno e no
    // intro log de uma vez só.
    const audio = await attachAudio(sess, combined);
    const transitionAudioSec = audio.audio_duration_seconds ?? null;

    sess.introLog.push({
      role: "assistant",
      content: intro.message,
      at: new Date().toISOString(),
      audio_duration_seconds: transitionAudioSec,
    });
    sess.introTransitionedAt = new Date().toISOString();
    const firstTurn = turnFromPlanQuestion(0, firstPlanQuestion);
    firstTurn.question_audio_duration_seconds = transitionAudioSec;
    sess.turnLog.push(firstTurn);
    sess.questionIndex = 1;
    sess.currentPhase = "interviewing";

    sess.conv_chat.push({ role: "assistant", content: combined });
    sess.conv_eval.push({
      role: "assistant",
      content: combined,
      metadata: { phase: "intro_to_interviewing", documentMap: sess.documentMap, interviewPlan: sess.interviewPlan, timestamp: Date.now() },
    });
    sess.history = sess.conv_chat;
    try {
      await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: combined }] });
      await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: combined }] });
    } catch (err) {
      log.error("CHAT", `remote write (intro transition) failed: ${err.message}`);
    }
    log.info("CHAT", `intro transition + first plan question ${log.preview(combined, 160)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");
    persist();
    return res.json({ channel: "chat", assistant: combined, ...audio });
  }

  const planHasMoreQuestions = sess.questionIndex < (sess.interviewPlan?.questions?.length ?? 0);
  const currentTurn = sess.turnLog?.[sess.turnLog.length - 1];

  // Carries the sufficiency-generated transition phrase from the triage block
  // down to the normal flow (where the next plan question is assembled). Stays
  // null when sufficiency wasn't run, errored out, or chose follow_up.
  let acceptedTransitionPhrase = null;

  // ------------------------------------------------------------------
  // Triage + sufficiency phase. All four agents are launched in parallel
  // as soon as the message arrives. Triage (3 fast agents) decides whether
  // the message should be intercepted as scope/off-topic/meta. Sufficiency
  // (1 reasoning agent) decides whether the answer is complete and coherent
  // enough to advance — but its result is only consumed when no triage
  // guardrail wins. If a guardrail wins, sufficiency is best-effort
  // cancelled via AbortSignal and its outcome is ignored.
  //
  // Both phases are gated by "plan still has a pending question and the
  // current turn is awaiting an answer".
  // ------------------------------------------------------------------
  if (planHasMoreQuestions && currentTurn && currentTurn.answer == null) {
    const triageContext = {
      interviewerYamlText: sess.interviewerYamlText ?? "",
      currentTurn,
      studentMessage: message,
      vectorStoreId: sess.vectorStoreId,
      meterCtx: sessionMeterCtx(sess),
    };

    const sufficiencyAbort = new AbortController();
    const sufficiencyPromise = answerSufficiencyAgent.evaluate({
      interviewerYamlText: sess.interviewerYamlText ?? "",
      currentTurn,
      turnLog: sess.turnLog,
      studentMessage: message,
      vectorStoreId: sess.vectorStoreId,
      signal: sufficiencyAbort.signal,
      meterCtx: sessionMeterCtx(sess),
    }).catch(err => {
      const aborted = err?.name === "APIUserAbortError"
        || err?.constructor?.name === "APIUserAbortError"
        || /aborted/i.test(err?.message ?? "");
      if (aborted) {
        log.info("AGENT:AnswerSufficiency", "aborted (triage winner)");
        return { aborted: true };
      }
      log.error("AGENT:AnswerSufficiency", `failed, defaulting to accept: ${err.message}`);
      return { aborted: false, decision: "accept", issue: "none", reason: "agent_failed", follow_up_question: null };
    });

    const fallback = (type, channel) => (err) => {
      log.error(`AGENT:${type}`, `failed, scoring as 0: ${err.message}`);
      return { type, channel, intensity: 0, assistant_response: "", rationale: `agent failed: ${err.message}` };
    };
    const [scopeResult, offTopicResult, metaResult] = await Promise.all([
      scopeClarificationAgent.evaluate(triageContext).catch(fallback("scope_clarification", "chat")),
      offTopicRedirectAgent.evaluate(triageContext).catch(fallback("off_topic_redirect", "chat")),
      metaInterventionAgent.evaluate(triageContext).catch(fallback("meta", "modal")),
    ]);
    const triageResults = [scopeResult, offTopicResult, metaResult];
    const scores = {
      scope_clarification: scopeResult.intensity,
      off_topic_redirect: offTopicResult.intensity,
      meta: metaResult.intensity,
    };
    log.info("TRIAGE", `scores scope=${scores.scope_clarification} off_topic=${scores.off_topic_redirect} meta=${scores.meta}`);

    const winner = pickTriageWinner(triageResults);
    if (winner) {
      sufficiencyAbort.abort();
      log.info("TRIAGE", `winner=${winner.type} intensity=${winner.intensity} channel=${winner.channel}`);
      // TTS antes do push para anexar a duração ao intervention.
      const audio = await attachAudio(sess, winner.assistant_response);
      const intervention = {
        type: winner.type,
        student_message: message,
        assistant_response: winner.assistant_response,
        intensity: winner.intensity,
        channel: winner.channel,
        scores,
        at: new Date().toISOString(),
        student_audio_duration_seconds: studentAudioDurationSec,
        assistant_audio_duration_seconds: audio.audio_duration_seconds ?? null,
      };
      if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
      currentTurn.interventions.push(intervention);

      if (winner.channel === "modal") {
        // Meta intervention: keep the student message OUT of conv_chat (local
        // and remote). Record into conv_eval for audit so the final evaluator
        // still sees the exchange if needed.
        sess.conv_eval.push({ role: "user", content: message, metadata: { triage: "meta", dropped_from_chat: true, timestamp: Date.now() } });
        sess.conv_eval.push({ role: "assistant", content: winner.assistant_response, metadata: { triage: "meta", channel: "modal", timestamp: Date.now() } });
        try {
          await openai.conversations.items.create(sess.conversationId_eval, {
            items: [
              { role: "user", content: message },
              { role: "assistant", content: winner.assistant_response },
            ],
          });
        } catch (err) {
          log.error("CHAT", `remote eval write (meta) failed: ${err.message}`);
        }
        persist();
        return res.json({
          channel: "modal",
          assistant_response: winner.assistant_response,
          restore_input: message,
          ...audio,
        });
      }

      // Chat-channel intervention (scope_clarification / off_topic_redirect):
      // student message and agent response DO flow through conv_chat.
      sess.conv_chat.push({ role: "user", content: message });
      sess.conv_chat.push({ role: "assistant", content: winner.assistant_response });
      sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
      sess.conv_eval.push({ role: "assistant", content: winner.assistant_response, metadata: { triage: winner.type, timestamp: Date.now() } });
      sess.history = sess.conv_chat;
      try {
        await openai.conversations.items.create(sess.conversationId_chat, {
          items: [
            { role: "user", content: message },
            { role: "assistant", content: winner.assistant_response },
          ],
        });
        await openai.conversations.items.create(sess.conversationId_eval, {
          items: [
            { role: "user", content: message },
            { role: "assistant", content: winner.assistant_response },
          ],
        });
      } catch (err) {
        log.error("CHAT", `remote write (triage=${winner.type}) failed: ${err.message}`);
      }
      log.info("CHAT", `user (triaged=${winner.type}) ${log.preview(message, 140)}`);
      await logLastConvItem(sess.conversationId_chat, "CONV:chat");
      persist();
      return res.json({ channel: "chat", assistant: winner.assistant_response, ...audio });
    }

    // No triage winner — sufficiency now blocks the move to the next turn.
    const sufficiency = await sufficiencyPromise;
    if (sufficiency.decision === "follow_up" && sufficiency.follow_up_question) {
      log.info("AGENT:AnswerSufficiency", `follow_up issue=${sufficiency.issue}`);
      // TTS antes do push para anexar a duração ao intervention.
      const audio = await attachAudio(sess, sufficiency.follow_up_question);
      const intervention = {
        type: "follow_up",
        issue: sufficiency.issue,
        student_message: message,
        assistant_response: sufficiency.follow_up_question,
        channel: "chat",
        reason: sufficiency.reason,
        diminishing_returns_check: sufficiency.diminishing_returns_check ?? null,
        at: new Date().toISOString(),
        student_audio_duration_seconds: studentAudioDurationSec,
        assistant_audio_duration_seconds: audio.audio_duration_seconds ?? null,
      };
      if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
      currentTurn.interventions.push(intervention);

      sess.conv_chat.push({ role: "user", content: message });
      sess.conv_chat.push({ role: "assistant", content: intervention.assistant_response });
      sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
      sess.conv_eval.push({ role: "assistant", content: intervention.assistant_response, metadata: { intervention: "follow_up", issue: sufficiency.issue, timestamp: Date.now() } });
      sess.history = sess.conv_chat;
      try {
        await openai.conversations.items.create(sess.conversationId_chat, {
          items: [
            { role: "user", content: message },
            { role: "assistant", content: intervention.assistant_response },
          ],
        });
        await openai.conversations.items.create(sess.conversationId_eval, {
          items: [
            { role: "user", content: message },
            { role: "assistant", content: intervention.assistant_response },
          ],
        });
      } catch (err) {
        log.error("CHAT", `remote write (follow_up) failed: ${err.message}`);
      }
      log.info("CHAT", `user (follow_up=${sufficiency.issue}) ${log.preview(message, 140)}`);
      await logLastConvItem(sess.conversationId_chat, "CONV:chat");
      persist();
      return res.json({ channel: "chat", assistant: intervention.assistant_response, ...audio });
    }
    // accept (or aborted/failed defaulting to accept). Capture the transition
    // phrase generated by sufficiency so the normal flow can prepend it to
    // the next plan question.
    if (sufficiency.decision === "accept" && sufficiency.transition_phrase) {
      acceptedTransitionPhrase = sufficiency.transition_phrase;
    }
  }

  // ------------------------------------------------------------------
  // Normal flow (no triage intervention). Student message becomes the
  // answer to the current turn; next plan question (or the wrap-up
  // sentinel if the plan is exhausted) is returned.
  // ------------------------------------------------------------------
  sess.conv_chat.push({ role: "user", content: message });
  sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
  sess.history = sess.conv_chat;

  if (currentTurn && currentTurn.answer == null) {
    currentTurn.answer = message;
    currentTurn.answered_at = new Date().toISOString();
    currentTurn.answer_audio_duration_seconds = studentAudioDurationSec;
    if (acceptedTransitionPhrase) {
      currentTurn.transition_to_next = acceptedTransitionPhrase;
    }
    persist();
  }

  try {
    await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
    await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "user", content: message }] });

    log.info("CHAT", `user #${sess.questionIndex} ${log.preview(message, 140)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    // Relevance pass: before serving the next planned question, ask whether
    // it still makes sense given the conversation so far. Skip-loops past
    // questions whose substance is already covered. Bounded to keep a
    // misbehaving agent from emptying the rest of the plan.
    let relevanceSkips = 0;
    while (sess.questionIndex < sess.interviewPlan.questions.length && relevanceSkips < MAX_RELEVANCE_SKIPS) {
      const candidate = sess.interviewPlan.questions[sess.questionIndex];
      let decision;
      try {
        decision = await questionRelevanceAgent.evaluate({
          interviewerYamlText: sess.interviewerYamlText ?? "",
          turnLog: sess.turnLog,
          candidateQuestion: candidate,
          meterCtx: sessionMeterCtx(sess),
        });
      } catch (err) {
        log.error("AGENT:QuestionRelevance", `failed, defaulting to ask: ${err.message}`);
        decision = { decision: "ask", reason: "agent_failed" };
      }
      if (decision.decision === "skip") {
        if (!Array.isArray(sess.skippedQuestions)) sess.skippedQuestions = [];
        sess.skippedQuestions.push({
          plan_id: candidate?.id ?? null,
          question: candidate?.question ?? "",
          rationale: candidate?.rationale ?? null,
          reason: decision.reason,
          at: new Date().toISOString(),
        });
        log.info("RELEVANCE", `skip plan_id=${candidate?.id} reason=${log.preview(decision.reason, 120)}`);
        sess.questionIndex++;
        relevanceSkips++;
        persist();
        continue;
      }
      log.info("RELEVANCE", `ask plan_id=${candidate?.id}`);
      break;
    }
    if (relevanceSkips >= MAX_RELEVANCE_SKIPS) {
      log.error("RELEVANCE", `cap reached (${MAX_RELEVANCE_SKIPS}); forcing ask on questionIndex=${sess.questionIndex}`);
    }

    let assistantResponse;
    let nextTurnRef = null;
    if (sess.questionIndex < sess.interviewPlan.questions.length) {
      const planQuestion = sess.interviewPlan.questions[sess.questionIndex];
      const nextQuestion = planQuestion?.question;
      if (!nextQuestion) {
        throw new Error("Question not found in interview plan");
      }
      const phrase = acceptedTransitionPhrase || "Próxima pergunta.";
      assistantResponse = `${phrase}\n\n${nextQuestion}`;
      nextTurnRef = turnFromPlanQuestion(sess.turnLog.length, planQuestion);
      sess.turnLog.push(nextTurnRef);
      sess.questionIndex++;
      persist();
      log.info("TURN", `q#${sess.questionIndex} (sequential from plan)${acceptedTransitionPhrase ? " with sufficiency phrase" : " with default phrase"}`);
    } else {
      assistantResponse = "Obrigado pelas respostas. Acredito que já tenho informações suficientes para avaliar. Use o botão 'Finalizar' quando estiver pronto.";
      sess.currentPhase = "finalizing";
      log.info("TURN", `all questions covered or completed, finalizing`);
    }

    sess.conv_chat.push({ role: "assistant", content: assistantResponse });
    sess.conv_eval.push({ role: "assistant", content: assistantResponse, metadata: { timestamp: Date.now() } });
    sess.history = sess.conv_chat;

    await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: assistantResponse }] });
    await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: assistantResponse }] });

    log.info("CHAT", `assistant ${log.preview(assistantResponse, 140)}`);
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    const audio = await attachAudio(sess, assistantResponse);
    // Persiste a duração do TTS no novo turno (quando há próximo turno do plano)
    // — essa é a duração do áudio da pergunta + frase de transição.
    if (nextTurnRef) {
      nextTurnRef.question_audio_duration_seconds = audio.audio_duration_seconds ?? null;
      persist();
    }
    res.json({ channel: "chat", assistant: assistantResponse, ...audio });
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

    await db.setFinalReport(req.submission.id, JSON.stringify(report, null, 2));

    log.info("FINAL", `submission=${token} C1=${report.breakdown.C1_compreensao} C2=${report.breakdown.C2_metodologia} C3=${report.breakdown.C3_parametros} total=${report.score_total}`);

    sess.conversationCompleted = true;
    await persistConversationLog(
      sess,
      req.submission.id,
      req.work.work_token,
      token,
      req.submission.student_label,
    );

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
      meteredResponses(
        { ...sessionMeterCtx(session), agentLabel: "EVAL:Methodology", model: PRINCIPAL_REASONING_MODEL },
        () => openai.responses.create({
          model: PRINCIPAL_REASONING_MODEL,
          instructions: prompt,
          input: [{ role: "user", content: "Avalie a metodologia." }]
        })
      )
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
      meteredResponses(
        { ...sessionMeterCtx(session), agentLabel: "EVAL:Parameters", model: PRINCIPAL_REASONING_MODEL },
        () => openai.responses.create({
          model: PRINCIPAL_REASONING_MODEL,
          instructions: prompt,
          input: [{ role: "user", content: "Avalie os parâmetros." }]
        })
      )
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
  // Aplica migrations pendentes antes de qualquer coisa. Fail-fast: se
  // qualquer migration falha, o servidor não sobe. Ver "Schema do banco —
  // diretriz permanente" em CLAUDE.md.
  await runMigrations();
  try {
    await seedInitialUsers();
  } catch (err) {
    log.error("BOOT", `seedInitialUsers failed: ${err.message}`);
  }
  try {
    await seedInterviewerTemplates();
  } catch (err) {
    log.error("BOOT", `seedInterviewerTemplates failed: ${err.message}`);
  }
  log.info("BOOT", `server listening http://0.0.0.0:${PORT} log_level=${log.level} model=${PRINCIPAL_REASONING_MODEL}`);
});

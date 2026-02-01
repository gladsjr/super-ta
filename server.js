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
// MODEL CONFIGURATION - Easily adjustable per agent
// ============================================================================
const MODELS = {
  DEFAULT: "gpt-5.2",           // For simple tasks (chat, questions)
  MAP_BUILDER: "gpt-5.2",           // Advanced model for document analysis
  COMPREHENSION_EVAL: "gpt-5.2",    // Advanced model for comprehension evaluation
  CLARIFICATION_EVAL: "gpt-5.2",    // Advanced model for clarification identification
  METHODOLOGY_EVAL: "gpt-5.2",      // For C2 evaluation
  PARAMETERS_EVAL: "gpt-5.2"        // For C3 evaluation
};

const OPENAI_MODEL = MODELS.DEFAULT;

// helpers
function loadSystemPrompt() {
  const cfgDir = path.join(__dirname, "config");
  const systemPrompt = fs.readFileSync(path.join(cfgDir, "system_prompt.txt"), "utf-8");
  return systemPrompt;
}

/**
 * Generate DocumentMap: Global document understanding
 * Extracts structure, thesis, methodology, key claims, weak points
 */
async function generateDocumentMap(fileId) {
  const prompt = `Você é um assistente de análise de documentos. Analise o documento anexado e gere um resumo estruturado JSON com:

1. **thesis**: Qual é a tese/objetivo principal do trabalho?
2. **structure**: Quais são as seções principais? (lista breve)
3. **methodology**: Que metodologia ou abordagem foi usada?
4. **keyClaims**: Quais são as principais afirmações/conclusões? (lista de 2-4 pontos)
5. **weakPoints**: Há pontos fracos, incompletos ou ambíguos no documento? (lista de 1-3 itens)

Retorne apenas JSON válido, sem texto adicional.

Exemplo:
{
  "thesis": "Calcular viabilidade econômica de mineração caseira de Bitcoin",
  "structure": ["Introdução", "Parâmetros", "Cálculos", "Conclusão"],
  "methodology": "Análise de payback com planilha Excel",
  "keyClaims": ["Payback de 18 meses", "Consumo energético é fator crítico"],
  "weakPoints": ["Não justifica valor de taxa elétrica usado", "Falta análise de risco"]
}`;

  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      instructions: prompt,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analise este documento:" },
            { type: "input_file", file_id: fileId }
          ]
        }
      ]
    });

    const outputText = response.output_text || "{}";
    // Extract JSON from response (might have markdown code blocks)
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(outputText);
  } catch (error) {
    console.error("Erro ao gerar DocumentMap:", error);
    return {
      thesis: "Não foi possível extrair",
      structure: [],
      methodology: "Desconhecida",
      keyClaims: [],
      weakPoints: ["Erro na análise do documento"]
    };
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

    console.log(`✓ Vector Store criado: ${vectorStore.id}`);
    return vectorStore.id;
  } catch (error) {
    console.error("❌ Erro ao criar Vector Store:", error);
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

  // Run both evaluator agents in parallel
  const [comprehensionSignal, clarificationSignal] = await Promise.all([
    comprehensionEvaluator.evaluate(
      session.conversationId_eval,  // Uses eval conversation (created implicitly if null)
      session.vectorStoreId,
      session.documentMap,
      studentResponse
    ),
    clarificationEvaluator.evaluate(
      session.conversationId_eval,  // Uses eval conversation (created implicitly if null)
      session.vectorStoreId,
      session.documentMap,
      studentResponse
    )
  ]);

  if (!session.conversationId_eval) {
    session.conversationId_eval = comprehensionSignal.conversationId || clarificationSignal.conversationId || null;
  }

  signals.push(comprehensionSignal, clarificationSignal);

  // Store signals in session
  session.evaluationSignals.push(...signals);

  // Log to eval conversation
  session.conv_eval.push({
    role: "system",
    content: `[EVALUATION SIGNALS] ${JSON.stringify(signals, null, 2)}`,
    metadata: { signals, timestamp: Date.now() }
  });

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

  // Get recent conversation (last 3 exchanges)
  const recentChat = session.conv_chat.slice(-6).map(m =>
    `${m.role === 'user' ? 'Aluno' : 'TA'}: ${m.content}`
  ).join('\n');

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

    if (session.conversationId_chat) {
      payload.conversation_id = session.conversationId_chat;
    }

    const response = await openai.responses.create(payload);

    if (!session.conversationId_chat && response.conversation_id) {
      session.conversationId_chat = response.conversation_id;
    }

    return response.output_text || "Pode me explicar melhor esse ponto do seu trabalho?";
  } catch (error) {
    console.error("Erro ao gerar próxima pergunta:", error);
    return "Pode me explicar melhor esse ponto do seu trabalho?";
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
app.post("/session", (_req, res) => {
  const id = Math.random().toString(36).slice(2, 14);
  const systemPrompt = loadSystemPrompt();

  // Note: Conversations API creates conversations implicitly on first responses.create() call
  // We store conversation IDs that will be set on first use
  const sess = {
    systemPrompt,
    // Dual conversations (IDs will be set on first responses.create() call)
    conversationId_chat: null,   // Student-facing conversation
    conversationId_eval: null,   // Internal evaluation conversation
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

  console.log(`✓ Sessão ${id} criada (conversations criadas implicitamente no primeiro uso)`);

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

    // 2) Create Vector Store for RAG/file_search (needed for MapBuilder)
    console.log("Criando Vector Store...");
    sess.vectorStoreId = await createVectorStoreWithFile(fileUpload.id, sessionId);

    // 3) Generate DocumentMap using MapBuilder Agent (fail fast if error)
    console.log("Gerando DocumentMap com MapBuilder Agent...");
    const mapResult = await mapBuilderAgent.generateDocumentMap(
      sess.conversationId_eval,
      sess.vectorStoreId
    );
    sess.documentMap = mapResult.documentMap;
    if (!sess.conversationId_eval && mapResult.conversationId) {
      sess.conversationId_eval = mapResult.conversationId;
    }
    console.log("✓ DocumentMap gerado:", JSON.stringify(sess.documentMap, null, 2));

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

    if (sess.conversationId_chat) {
      payload.conversation_id = sess.conversationId_chat;
    }

    const response = await openai.responses.create(payload);

    if (!sess.conversationId_chat && response.conversation_id) {
      sess.conversationId_chat = response.conversation_id;
    }

    const assistantMessage = response.output_text || "Arquivo recebido. Podemos iniciar nossa avaliação?";

    // Store in both conversations
    sess.conv_chat.push({ role: "assistant", content: assistantMessage });
    sess.conv_eval.push({
      role: "assistant",
      content: assistantMessage,
      metadata: { documentMap: sess.documentMap }
    });
    sess.history = sess.conv_chat; // Maintain backward compatibility

    // Update state
    sess.currentPhase = 'interviewing';

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

  // ===== TURN DYNAMICS PROTOCOL =====
  // 1. Student responds - store in both conversations
  sess.conv_chat.push({ role: "user", content: message });
  sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
  sess.history = sess.conv_chat; // Maintain backward compatibility

  try {
    // 2. Run evaluators (internal analysis)
    console.log("\n[TURN DYNAMICS] Executando avaliadores...");
    const signals = await runEvaluators(sess, message);
    console.log(`[TURN DYNAMICS] ${signals.length} sinais gerados`);

    // 3. Orchestrator decides next action based on signals
    const decision = await orchestrateNextAction(sess, signals);
    console.log(`[TURN DYNAMICS] Decisão: ${decision.action}`);

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

    sess.questionCount++;

    res.json({ assistant: assistantResponse });
  } catch (error) {
    console.error("Erro no chat:", error);
    res.status(500).json({ error: "Erro ao processar mensagem" });
  }
});

// 4) finalizar (consolidação baseada em avaliadores)
app.post("/finalize", async (req, res) => {
  const sessionId = String(req.query.session || "");
  const sess = SESSIONS.get(sessionId);
  if (!sess) return res.status(400).json({ error: "invalid session" });

  try {
    // Consolidate all evaluation signals
    const allSignals = sess.evaluationSignals;

    // Calculate rubric-based scores
    const rubricScores = await calculateRubricScores(sess, allSignals);

    // Generate final report
    const report = generateFinalReport(sess, rubricScores);

    res.json(report);
  } catch (error) {
    console.error("Erro ao finalizar avaliação:", error);
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
    const response = await openai.responses.create({
      model: MODELS.METHODOLOGY_EVAL,
      instructions: prompt,
      input: [{ role: "user", content: "Avalie a metodologia." }]
    });

    const outputText = response.output_text || "{}";
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 5, rationale: "Sem dados" };
    return result.score || 5;
  } catch (error) {
    console.error("Erro ao avaliar metodologia:", error);
    return 5;
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
    const response = await openai.responses.create({
      model: MODELS.PARAMETERS_EVAL,
      instructions: prompt,
      input: [{ role: "user", content: "Avalie os parâmetros." }]
    });

    const outputText = response.output_text || "{}";
    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 5, rationale: "Sem dados" };
    return result.score || 5;
  } catch (error) {
    console.error("Erro ao avaliar parâmetros:", error);
    return 5;
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
    console.warn("⚠️  OPENAI_API_KEY ausente no .env");
  }
  console.log(`TA-Assignment MVP rodando em http://0.0.0.0:${PORT}`);
});

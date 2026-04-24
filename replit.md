# TA-Assignment (SuperTA) – Production Architecture

## Overview
SuperTA is an assignment evaluation system that conducts a **structured, stateful interview** with students about their submitted work, aiming to assess **authorship, understanding, and conceptual coherence**, not just textual correctness.

The system combines:
- A **code-controlled state machine** for orchestration
- **Specialized AI agents** for cognitive tasks (document analysis, evaluation)
- **Dual-state conversations** (student-facing vs internal evaluation)
- **Two-layer document understanding** (global DocumentMap + local RAG)

---

## Architectural Principles

### 🎯 Core Rules
1. **Code orchestrates, AI agents analyze and propose**
   - State machine logic lives in application code
   - Agents never control flow, only provide signals
   
2. **Conversation history ≠ operational state**
   - `conv_chat`: Student-facing dialogue only
   - `conv_eval`: Internal analysis, signals, and mirrored chat
   
3. **Fail Fast, No Architectural Fallbacks**
   - Critical components (MapBuilder, Vector Store) must work or fail explicitly
   - No silent degradation to legacy implementations
   - Errors are architectural feedback, not edge cases

4. **Single source of truth for runtime configuration**
  - Runtime model selection must come from `config/policy.yaml`
  - Avoid configuration hierarchies, env-var overrides for model choice, and hidden fallbacks
  - If a required config is missing, fail explicitly at boot
   
5. **Global understanding via DocumentMap**
   - Generated once by MapBuilder Agent, which reads the full document via `input_file` attached to the Responses API
   - Compressed context injected into all evaluators

6. **Local verification via RAG**
   - Vector Store (`file_search`) used by evaluators and question generation for citations
   - Cite specific sections, tables, figures
   
7. **Internal evaluation never exposed to student**
   - All evaluation signals stay in `conv_eval`
   - Student only sees questions and final score

---

## Project Structure
- `server.js` – Express server with orchestration logic and agents
- `auth.js` – Authentication module (bcrypt, express-session, PostgreSQL store)
- `static/index.html` – Frontend chat interface (with login screen)
- `config/`
  - `assignment.json` – Assignment goals and constraints
  - `rubric.json` – Evaluation criteria (C1: 40%, C2: 40%, C3: 20%)
  - `system_prompt.txt` – Base behavioral constraints for TA
  - `policy.yaml` – Runtime policy and model configuration, including `models.principal_reasoning_model`
- `data/submissions/` – Uploaded student files (by session ID)

---

## Core Runtime Concepts

### 1. Dual Conversations (State Separation)

Each session maintains **two independent conversational states**:

- **Student Conversation (`conv_chat`)**
  - Only what the student sees
  - Questions and answers
  - No internal reasoning or flags

- **Evaluator Conversation (`conv_eval`)**
  - Mirrors the visible chat
  - Plus internal analyses, signals, and document understanding
  - Used for auditability and cumulative evaluation

### 2. Document Handling Strategy

Student documents are processed in two complementary ways:

#### Global View – DocumentMap
- Generated once after upload by **MapBuilder Agent**
- Reads the full document by attaching it as `input_file` to a **Responses API** call (no `file_search` used here — the agent sees the entire document directly)
- Structured summary of:
  - thesis and structure
  - methodology
  - key claims
  - weak points
- Always injected into evaluator prompts
- Serves as **compressed global context**

#### Local View – Vector Store (RAG)
- Full document indexed via OpenAI Vector Store (`openai.vectorStores.create`)
- Exposed as a `file_search` tool to:
  - `ComprehensionEvaluatorAgent` and `ClarificationEvaluatorAgent` (evidence gathering)
  - `generateNextQuestion()` in `server.js` (grounded question generation)
- Used to verify claims, locate sections/tables/figures, and support evidential questioning

> Global understanding comes from the DocumentMap;
> verification and grounding come from the Vector Store via `file_search`.

### 3. Turn Dynamics (Invariant Flow)

The system always follows this loop:

1. **Student responds**
2. Response is stored in both conversations; **no evaluation yet**
3. One or more **internal evaluators run** (ComprehensionEvaluator, ClarificationEvaluator)
4. Signals are consolidated
5. The orchestrator decides the next action (followup, continue, finalize)
6. SuperTA asks the next question or follow-up

> **Invariant**: Evaluation **only runs after student input**, never after SuperTA output.

---

## Cognitive Agents

All three agents are implemented as classes under `agents/` and call the **Responses API**. They `throw` on any internal error (fail-fast).

### MapBuilderAgent (`agents/MapBuilderAgent.js`)
- **Purpose**: Generate the structured DocumentMap
- **Input**: The full document attached via `input_file` on the Responses API (no `file_search`)
- **Output**: Validated JSON with `thesis`, `structure`, `methodology`, `keyClaims`, `weakPoints`
- **Criticality**: **Must succeed** – no fallback

### ComprehensionEvaluatorAgent (`agents/ComprehensionEvaluatorAgent.js`)
- **Purpose**: Assess whether the student understands their own work
- **Tools**: `file_search` against the session's Vector Store
- **Output**: `{ type: 'comprehension', confidence: 0.0-1.0, data: { understands, evidence, redFlags, suggestedFollowUp } }`
- **Maps to**: Rubric C1 (40%)

### ClarificationEvaluatorAgent (`agents/ClarificationEvaluatorAgent.js`)
- **Purpose**: Identify unclear aspects that require targeted questions
- **Tools**: `file_search` against the session's Vector Store
- **Output**: `{ type: 'clarification', confidence: 0.0-1.0, data: { needsClarification, unclearAspects, suggestedQuestion } }`

---

## Orchestration Model

- **State machine lives in application code** (`server.js`)
- **Orchestrator controls**:
  - Question count and limits (MAX_QUESTIONS = 8)
  - Follow-up thresholds (FOLLOWUP_THRESHOLD = 0.5)
  - Which evaluators are invoked
  - What becomes public dialogue
- **AI agents provide signals and candidates**:
  - Never decide control flow
  - Only analyze and propose actions

---

## OpenAI Integration

### APIs Used
- **Files API** (`openai.files.create`): Upload student documents
- **Vector Stores API** (`openai.vectorStores.create`, top-level in SDK v6): Index documents for RAG with `file_search`
- **Conversations API** (`openai.conversations.create`, `conversations.items.*`): Persists per-session `conv_chat` and `conv_eval` server-side
- **Responses API** (`openai.responses.create`): All generation — DocumentMap, evaluator signals, next questions, C2/C3 scoring

> The system does **not** use the Assistants API. Cognitive agents are local classes (`agents/*.js`) that encapsulate prompts + tool wiring around the Responses API.

### SDK Version
- `openai@^6.17.0` (see `package.json`)

---

## API Endpoints
- `GET /` – Serves the main HTML interface
- `POST /session` – Creates a new evaluation session with dual-state structure
- `POST /upload?session=<id>` – Uploads and processes student document
  - Creates Vector Store
  - Runs MapBuilder Agent
  - Generates initial question
- `POST /chat?session=<id>` – Student sends a message
  - Stores in both conversations
  - Runs evaluators
  - Orchestrator decides next action
  - Generates response
- `POST /finalize?session=<id>` – Generates final evaluation report
  - Consolidates evaluation signals
  - Calculates rubric scores (C1, C2, C3)
  - Returns weighted total score

---

## Environment Variables
- `OPENAI_API_KEY` – Required (get from platform.openai.com)
- `PORT` – Defaults to 5000
- `DATABASE_URL` – PostgreSQL connection (auto-provisioned by Replit)
- `INITIAL_USERS` – Seeded users in format `user1:pass1,user2:pass2` (created on startup if missing)
- `SESSION_SECRET` – Optional; auto-generated if absent (use a stable value in production)

Model selection is intentionally not controlled by environment variables. Set the reasoning model in `config/policy.yaml` only.

## Authentication
- Simple username/password login with bcrypt-hashed passwords stored in PostgreSQL `users` table
- Session cookies (HTTP-only, signed) backed by `app_session` table via `connect-pg-simple`
- Session ID is regenerated on login to prevent session fixation
- `cookie.secure` is enabled when `NODE_ENV=production`
- Routes `/session`, `/upload`, `/chat`, `/finalize` require authentication
- Each in-memory eval session is bound to its creator (`ownerUserId`); cross-user access returns 403
- Auth endpoints: `POST /login`, `POST /logout`, `GET /me`

---

## Running the Application

### Install Dependencies
```bash
npm install
```

### Apply Database Schema (first run only)
The `users` and `app_session` tables must exist before the first boot. Apply the idempotent schema:
```bash
psql "$DATABASE_URL" -f schema.sql
```

### Start Server
```bash
npm run dev
```

Server starts at `http://localhost:5000`

---

## Session State Structure

```javascript
{
  systemPrompt: "...",

  // Dual conversations: both the remote Conversation IDs (source of truth)
  // and local caches used for display and logging
  conversationId_chat: "conv_...",   // Remote conversation for student-facing turns
  conversationId_eval: "conv_...",   // Remote conversation for internal evaluation
  conv_chat: [],                     // Local cache (student-facing)
  conv_eval: [],                     // Local cache (internal + mirrored)
  history: [],                       // Alias to conv_chat (backward compat)

  // Document understanding
  documentMap: {              // From MapBuilderAgent
    thesis: "...",
    structure: [...],
    methodology: "...",
    keyClaims: [...],
    weakPoints: [...]
  },
  submissionPath: "...",
  openaiFileId: "file-xxx",
  vectorStoreId: "vs-xxx",

  // State machine
  currentPhase: "awaiting_upload" | "interviewing" | "finalizing",
  questionCount: 0,
  evaluationSignals: []       // Accumulated from evaluators
}
```

---

## Evaluation Rubric

Defined in `config/rubric.json`:

- **C1: Compreensão** (40%) – Does student understand their own work?
- **C2: Metodologia** (40%) – Is methodology correct?
- **C3: Parâmetros** (20%) – Are parameter values adequate?

Final score is weighted average (0-10).

---

## Recent Changes

### 2026-04-19: Documentation/Code Alignment
- Rewrote Cognitive Agents, OpenAI Integration and Project Structure sections to match the current code
- Clarified: MapBuilder reads the document via `input_file`; `file_search` is used by evaluators and question generation
- Added Conversations API to "APIs Used" (used to persist `conv_chat` and `conv_eval` server-side)
- Removed reference to non-existent `config/replit-future.md`; added `config/policy.yaml`
- Model selection is defined in `config/policy.yaml` via `models.principal_reasoning_model`; avoid env/model fallback hierarchies
- Deleted obsolete `ARCHITECTURE_EVOLUTION.md`
- Removed dead `generateDocumentMap` helper in `server.js`
- C2/C3 scoring (`evaluateMethodology`, `evaluateParameters`) now fail-fast on LLM errors instead of returning a silent default of 5

### 2026-01-31: Agent-Based Architecture
- ✅ Cognitive agents split into class-based modules under `agents/` (Responses API under the hood)
- ✅ Dual-state conversations (conv_chat + conv_eval), persisted via the Conversations API
- ✅ Vector Store integration for RAG
- ✅ Turn Dynamics protocol with evaluators
- ✅ Orchestrator-controlled state machine
- ✅ Updated SDK to openai@^6.17.0
- ✅ **Removed architectural fallbacks** – fail fast on critical components

### 2025-12-29: OpenAI Integration
- Integrated Files API and Responses API for file analysis

### 2025-12-28: Replit Configuration
- Configured for port 5000, host 0.0.0.0

---

## Development Principles

### When to Use Agents
✅ Task requires **reasoning over documents** (file_search)  
✅ Need **structured outputs** with validation  
✅ Complex cognitive task (analysis, evaluation)

❌ **Never** use agents for orchestration/control flow  
❌ **Never** use agents for simple text generation

### Error Handling Philosophy
- **Critical components fail explicitly** (Vector Store, MapBuilder)
- **No silent degradation** to legacy methods
- **Errors are signals** that architecture needs attention
- **Graceful user messaging** without exposing internals

### Configuration Discipline
- Prefer one explicit configuration source over layered overrides
- Do not introduce fallback chains for runtime model choice
- Do not add "just in case" defaults that obscure the active configuration

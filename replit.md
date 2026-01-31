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
   
4. **Global understanding via DocumentMap**
   - Generated once by MapBuilder Agent with `file_search`
   - Compressed context injected into all evaluators
   
5. **Local verification via RAG**
   - Vector Store enables evidential questioning
   - Cite specific sections, tables, figures
   
6. **Internal evaluation never exposed to student**
   - All evaluation signals stay in `conv_eval`
   - Student only sees questions and final score

---

## Project Structure
- `server.js` – Express server with orchestration logic and agents
- `static/index.html` – Frontend chat interface
- `config/`
  - `assignment.json` – Assignment goals and constraints
  - `rubric.json` – Evaluation criteria (C1: 40%, C2: 40%, C3: 20%)
  - `system_prompt.txt` – Base behavioral constraints for TA
  - `replit-future.md` – Architecture specification
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
- Uses `file_search` tool for deep document analysis
- Structured summary of:
  - thesis and structure
  - methodology
  - key claims
  - weak points
- Always injected into evaluator prompts
- Serves as **compressed global context**

#### Local View – Vector Store (RAG)
- Full document indexed via OpenAI Vector Store
- Used by agents to:
  - verify claims with citations
  - locate sections, tables, figures
  - support evidential questioning

> Global understanding comes from the DocumentMap;  
> verification and grounding come from RAG.

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

### MapBuilder Agent
- **Purpose**: Generate structured DocumentMap
- **Tools**: `file_search` for deep document analysis
- **Output**: Validated JSON with thesis, structure, methodology, keyClaims, weakPoints
- **Criticality**: **Must succeed** – no fallback

### ComprehensionEvaluator (Function, planned for Agent migration)
- **Purpose**: Assess if student understands their own work
- **Output**: Signal with confidence (0.0-1.0), evidence, redFlags, suggestedFollowUp
- **Maps to**: Rubric C1 (40%)

### ClarificationEvaluator (Function, planned for Agent migration)
- **Purpose**: Identify unclear aspects needing questions
- **Output**: Signal with needsClarification, unclearAspects, suggestedQuestion

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
- **Files API**: Upload student documents
- **Vector Stores API**: Index documents for RAG with `file_search`
- **Assistants API (Agents SDK)**: MapBuilder Agent with tools
- **Responses API**: Generate questions and evaluations

### SDK Version
- `openai@6.17.0` (requires Node.js 14+)

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

---

## Running the Application

### Install Dependencies
```bash
npm install
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
  
  // Dual conversations
  conv_chat: [],              // Student-facing only
  conv_eval: [],              // Internal + mirrored
  history: [],                // Alias to conv_chat (backward compat)
  
  // Document understanding
  documentMap: {              // From MapBuilder Agent
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

### 2026-01-31: Agent-Based Architecture
- ✅ Implemented MapBuilder Agent using Assistants API
- ✅ Dual-state conversations (conv_chat + conv_eval)
- ✅ Vector Store integration for RAG
- ✅ Turn Dynamics protocol with evaluators
- ✅ Orchestrator-controlled state machine
- ✅ Updated SDK to openai@6.17.0
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

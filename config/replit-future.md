# TA-Assignment (SuperTA) – MVP

## Overview
SuperTA is an assignment evaluation system that conducts a **structured, stateful interview**
with a student about their submitted work, aiming to assess **authorship, understanding,
and conceptual coherence**, not just textual correctness.

The system combines:
- a **code-controlled state machine**,
- **specialized LLM-based evaluators**,
- and a **two-layer document understanding strategy** (global + local).

---

## Architectural Principles (TL;DR)

- **Code orchestrates, LLMs analyze and propose**
- **Conversation history ≠ operational state**
- **Global understanding via DocumentMap**
- **Local verification via RAG (vector search)**
- **Internal evaluation is never exposed to the student**

---

## Project Structure
- `server.js` – Express server and **central orchestration logic**
- `static/index.html` – Frontend chat interface
- `config/`
  - `assignment.json` – Assignment goals and constraints
  - `rubric.json` – Evaluation criteria
  - `system_prompt.txt` – Base behavioral constraints
- `data/submissions/` – Uploaded student files
- `data/state/` – Persistent session and evaluation state (optional)

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

---

### 2. Document Handling Strategy

Student PDFs are treated in two complementary ways:

#### Global View – DocumentMap
- Generated once after upload
- Structured summary of:
  - thesis and structure
  - methodology
  - key claims
  - weak points
- Always injected into evaluator prompts
- Serves as **compressed global context**

#### Local View – Vector Store (RAG)
- Full PDF indexed via `file_search`
- Used to:
  - verify claims
  - locate sections, tables, figures
  - support evidential questioning

> Global understanding comes from the DocumentMap;  
> verification and grounding come from RAG.

---

### 3. Turn Dynamics (Invariant Flow)

The system always follows this loop:

1. **Student responds**
2. Response is stored in both conversations; **no evaluation yet**
3. One or more **internal evaluators run**
4. Signals are consolidated
5. The orchestrator decides the next action
6. SuperTA asks the next question or follow-up

> Evaluation **only runs after student input**, never after SuperTA output.

---

## Orchestration Model

- The **state machine lives in application code** (`server.js`)
- The orchestrator controls:
  - question count and limits
  - follow-up thresholds
  - which evaluators are invoked
  - what becomes public dialogue
- LLMs **never decide flow**, only provide signals and candidates

Agent frameworks (e.g. OpenAI Agents SDK) may be used as helpers,
but **do not own the control flow**.

---

## OpenAI Integration

The application uses OpenAI APIs as follows:

- **Responses API**
  - Internal evaluation (structured JSON outputs)
  - Student-facing questions
- **Conversations API**
  - Persistent conversational context
  - Separate state for chat and evaluation
- **file_search / Vector Store**
  - Localized evidence retrieval from student PDFs

---

## API Endpoints
- `GET /` – Serves the main HTML interface
- `POST /session` – Creates a new evaluation session
- `POST /upload?session=<id>` – Uploads and processes student PDF
- `POST /chat?session=<id>` – Student sends a message
- `POST /finalize?session=<id>` – Generates final evaluation report

---

## Environment Variables
- `OPENAI_API_KEY` – Required
- `PORT` – Defaults to 5000 (Replit compatible)

---

## Running the Application
```bash
npm run dev

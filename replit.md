# ORATIA – Production Architecture

## Overview
ORATIA is an assignment evaluation system that conducts a structured, stateful interview with students about their submitted work. Its primary purpose is to assess authorship, understanding, and conceptual coherence, moving beyond mere textual correctness.

Per-turn orchestration is **delegated to a single reasoning-model call** (`SuperOrchestratorAgent`) that receives full context (interviewer agenda, pre-generated work analysis, interview plan, the agent's own carried `memory`, conversation history, and the latest student message) and decides the next action by returning a JSON conforming to a fixed action schema. The code is a dispatcher around that decision, with hard guardrails (max turns cap, early-finalize blocking).

This replaced the earlier architecture of triage×3 + sufficiency + relevance running in parallel on every turn. See `docs/architecture.md` and `docs/super-orchestrator-plan.md` for the rationale and the action schema.

## User Preferences
Not specified.

## System Architecture

### Architectural Principles
The system adheres to core rules: critical components fail fast without architectural fallbacks; runtime configuration has a single source of truth (`config/policy.yaml`); per-turn cognitive load is concentrated in one reasoning call (`SuperOrchestratorAgent`) with hard code-side guardrails around it; pre-interview prep (work analysis + plan) is generated upfront once; local verification of the student's claims uses RAG (Vector Store) accessible to the super-orchestrator via `file_search`; internal evaluation is never exposed to the student.

### Project Structure
- `routes/interview.js`: Student-facing endpoints (`/start`, `/upload`, `/chat`, `/audio`, `/finalize`, `/intro/advance`). The `/chat` handler dispatches by phase: `intro` → `IntroductionAgent` (3 beats); `interviewing` → `SuperOrchestratorAgent` (one reasoning call per turn).
- `routes/work.js`: Professor-facing endpoints (`/info`, `/conversation`, `/interviewer`, `/config-chat`, `/enunciado/coherence`, `/submissions/:subToken/evaluation`, `/evaluations` batch evaluation (serial, in-background, in-memory progress state, per-item budget check), submission management).
- `routes/admin.js`: Admin endpoints (works, users).
- `agents/`: All agent classes. Per the super-orchestrator reform: `PrepBuilderAgent` (one-shot on `/upload`, analyze + build plan), `IntroductionAgent` (3 beats), `AudioIntelligibilityAgent` (pre-gate phrasing only), `SuperOrchestratorAgent` (per-turn orchestration in `interviewing`), `ConfigAssistantAgent` + `EnunciadoCoherenceAgent` (professor-facing).
- `lib/`: Shared infrastructure (db, sessionLifecycle, sessionState, conversationUtils, audio, billing, middleware, agentPreamble, interviewPrompt, audioIntelligibility, superOrchestrator/actionSchema).
- `config/`: `policy.yaml`, `pricing.yaml`, `voices.js`, `interview_prompt_template.txt`, `interviewer_agenda_template.txt`, `interviewers/*.yaml` (templates).
- `static/`: Frontend HTML (`student.html`, `professor.html`, `admin.html`, `conversation.html`, `student_instructions.html`).
- `migrations/`: SQL migrations, file-per-change (see CLAUDE.md).

### Core Runtime Concepts

#### Dual Conversations
Each session maintains two independent conversational states served by the OpenAI Conversations API:
- **Student Conversation (`conv_chat`)**: Visible to the student. The super-orchestrator reads this via the `conversation` parameter to get the full history server-side.
- **Evaluator Conversation (`conv_eval`)**: Audit trail of the same exchange with extra metadata (action kinds, rationale, intervention type). Visible to the professor through the conversation log view.

#### Document Handling Strategy
Student documents and the assignment statement are processed via:
- **Global View – `work_analysis`**: Generated once on `/upload` by `PrepBuilderAgent.analyzeWork` from both PDFs (via `input_file` to Responses API). Provides a structured executive summary, assessment (strengths/weaknesses/critical_points/authorship_doubts) and `evidence_index` (anchors to sections/figures worth checking). Persists in `runtime_state.super_orchestrator.work_analysis`.
- **Plan**: Built next by `PrepBuilderAgent.buildPlan`, informed by `work_analysis`. Same shape as the legacy interview plan (10 questions with associated YAML items). Persists in `runtime_state.interview_plan`.
- **Local View – Vector Store (RAG)**: BOTH PDFs (student + assignment) are indexed and exposed as `file_search` to the `SuperOrchestratorAgent` for per-turn evidence gathering. Generalized from the legacy single-file vector store.

#### Turn Dynamics
On every student turn in the `interviewing` phase:
1. STT (audio mode only) transcribes the message.
2. Pre-gate of intelligibility (algorithm over STT logprobs; `AudioIntelligibilityAgent` only phrases the repeat/give-up message) may intercept.
3. Student message is pushed to `conv_chat` and `conv_eval`.
4. `SuperOrchestratorAgent` is called with: interviewer agenda (rendered YAML), `work_analysis`, `interview_plan`, the agent's own `memory` carried from the previous turn, the conversation history (via the OpenAI `conversation` parameter), and the latest student message. Tools: `file_search` over the vector store. The agent returns a JSON with `rationale`, `action.kind` (one of `ask` / `follow_up` / `meta_modal` / `hint` / `finalize` / `ask_repeat`) and an updated `memory`.
5. The dispatcher in `routes/interview.js` translates `action.kind` into behavior (push to conv, persist, attach TTS audio, push intervention to current turn, transition phase, etc.).
6. Hard guardrails (turn caps): both derive per-session from the planned question count (`works.question_count`, professor-configurable, range 3–20, default 6, materialized in `interview_plan`). The cap that forces finalize is `questions × 3`; the floor that blocks early finalize is `⌈questions / 2⌉` (except when `finalize_reason="student_disengaged"`). At the legacy default of 10 these reproduce the old fixed 30/5. Schema-invalid output and agent failure both fall back to `ask_repeat`.
7. In audio mode, the response is streamed as SSE (`thinking` → `responding` on first model output text → `result`) so the frontend can flip the "ouvindo" label to "respondendo" at the real moment the agent starts producing text.

#### Session Persistence
Each turn writes a single atomic `UPDATE` to `submissions` covering both `conversation_json` (the professor-facing log) and the runtime state needed to resume the interview after a server restart: `current_phase`, `question_index`, `frozen_interaction_mode`, `frozen_voice`, and `runtime_state_json` (a JSONB blob holding the OpenAI resource IDs, interview plan, `work_analysis`, the super-orchestrator's `memory`, intro step, captured `studentName`, etc.). On `POST /s/:t/start` for a submission whose PDF is already in the DB, the server rehydrates the session, validates the four OpenAI resources (vector store, files, two conversations) in parallel, and reconstructs them from the stored PDFs if any have been deleted; the student sees a "Sessão recomposta" banner only in this rebuild path (text mode). `POST /s/:t/upload` rejects with 409 once an interview is in flight — to restart, the professor generates a new submission. `runtime_state_json IS NULL` is the canonical "no in-flight attempt" marker.

### Cognitive Agents
All agents are classes under `agents/` and use the Responses API, designed to fail fast. The active set:
- **`PrepBuilderAgent`** — one-shot on `/upload`, in two serialized calls (`analyzeWork` then `buildPlan`).
- **`IntroductionAgent`** — three deterministic beats for the social opening (`ask_name`, `present_self`, `begin`).
- **`AudioIntelligibilityAgent`** — fraseates the audio pre-gate's repeat-or-give-up message (decision is algorithmic, in `lib/audioIntelligibility.js`).
- **`SuperOrchestratorAgent`** — one reasoning call per turn in `interviewing`. Replaces the entire legacy per-turn agent fleet.
- **`ConfigAssistantAgent`** — professor-facing config chat (`/config-chat`).
- **`EnunciadoCoherenceAgent`** — professor-facing assignment-statement evaluator (`/enunciado/coherence`).
- **`InterviewEvaluatorAgent`** — professor-facing post-interview evaluator (`/w/:workToken/submissions/:subToken/evaluation`). Assesses how the student defended the work from the interviewer persona's perspective: both PDFs via `input_file`, rendered agenda, transcript serialized to text annotated with per-turn delivery metrics (latency, time-to-start-speaking, words/s, chars/s, disfluencies, written-register and polish scores — `lib/deliverySignals.js`, the same heuristics source used by the forensic `scripts/detect-ai-answers.mjs`; never audio bytes). Holistic: content decides per-question merit; delivery feeds a dedicated `delivery` section and corroborates authorship signals. Output cached in `submissions.evaluation_json`; `?force=true` regenerates. NEVER exposed to the student.
- **`StudentFeedbackAgent`** — derives the student-facing FORMATIVE feedback from the internal evaluation when the professor publishes it (`POST /w/:workToken/submissions/:subToken/evaluation/publish`; batch `POST /w/:workToken/evaluations/publish`; `DELETE` unpublishes). Strips grades/internal verdicts, authorship signals, delivery forensics and the professor's follow-up script. Two-layer sanitization: hard prompt rules + `FORBIDDEN_PATTERNS` sweep in code (leak → retry pointing at the leak → explicit failure rather than publish). Cached in `submissions.student_evaluation_json`; visibility gated by `evaluation_published_at`. Students read it at `GET /s/:submissionToken/evaluation` — deliberately NOT bound to the 7-day review window.

### Orchestration Model
The state machine resides in `routes/interview.js`. Code controls phase transitions and code-side guardrails (cap, early-finalize block, schema validation, fallback). Inside the `interviewing` phase, the **super-orchestrator decides everything else** — including when to ask, which question (planned or spontaneous), when to follow up, when to redirect a meta-question to the modal, when to show a hint, and when to finalize. The action JSON it returns is the contract; the dispatcher only does the I/O around it.

### Development Principles
- **When to Use Agents**: For reasoning over documents, structured outputs with validation, and complex cognitive tasks. Never for orchestration or simple text generation.
- **Error Handling**: Critical components fail explicitly; no silent degradation. Errors are architectural feedback.
- **Configuration**: One explicit configuration source (e.g., `config/policy.yaml`) is preferred over layered overrides or hidden defaults.

## External Dependencies

### OpenAI Integration
The system integrates with OpenAI using the following APIs:
- **Files API**: For uploading both the student and the assignment PDFs.
- **Vector Stores API**: Single vector store per session indexing BOTH the student and the assignment PDFs, exposed as `file_search` to `SuperOrchestratorAgent` and `PrepBuilderAgent`.
- **Conversations API**: To persist `conv_chat` and `conv_eval` server-side. The super-orchestrator reads `conv_chat` via the `conversation` request parameter to get full history without re-sending it. Server-side compaction (`context_management: [{type: "compaction", compact_threshold: 100000}]`) is passed in the request body so long interviews are compacted automatically.
- **Responses API**: For all generation tasks. The super-orchestrator request also uses `stream: true` when called from audio-mode `/chat`, so the server can emit a `responding` SSE event at the first `response.output_text.delta` (used by the student frontend to flip the "ouvindo" label to "respondendo" at the real moment).
- **Audio Transcriptions API** (STT): Converts student voice messages to text when the work is configured for audio mode. The pre-gate of intelligibility requests `include: ["logprobs"]` so it can detect ininteligible stretches algorithmically.
- **Audio Speech API** (TTS): Generates the interviewer's voice response when the work is configured for audio mode. Returns a single audio blob (not streamed in this codebase).

The system uses `openai@^6.17.0` and does **not** use the Assistants API.

### Interaction Modes (text vs audio)
Each work is configured by the professor as either `text` (default) or `audio`. Mode is stored in `works.interaction_mode`; when audio, `works.voice` holds one of the fixed voices defined in `config/voices.js`.

**Critical principle: analysis is always done on text.** Audio is the "last-mile" interface with the student only:
- Inbound (student): voice → STT → text → identical pipeline as text mode.
- Outbound (interviewer): LLM-generated text → TTS → audio served to the student.
- All agents, work analysis, vector store and conversation log operate on text exclusively.

Interviewer (TTS) audio is not persisted: it is cached per-session in memory (LRU of size 10) and served via `GET /s/:submissionToken/audio/:turnId`. On re-entry to an interview in audio mode, the student no longer sees the transcribed history — only the last interviewer audio is presented (reused from the in-memory cache when possible; regenerated via TTS once when the buffer is gone after a restart or LRU evict). This is intentional: visible transcripts make it trivial for the student to paste the question into an external LLM. Text mode is unaffected.

The **student's inbound audio**, however, *is* archived — for LGPD self-access (the student reviews their own recordings in the 7-day window) and audit. Bytes go to object storage under the key `audio/{submission_token}/{audio_idx}.{ext}`; only metadata lives in Postgres (`student_audio_artifacts`). Archiving is best-effort: a storage failure never breaks the interview. The storage backend is a single adapter, `lib/audioStore.js`, with two implementations selected once at boot:
- **`local`** — filesystem under `AUDIO_STORE_LOCAL_DIR` (default `<root>/.audio-store`, gitignored). For dev outside Replit.
- **`replit`** — Replit Object Storage (`@replit/object-storage`). Dev and prod on Replit.

Selection: env `AUDIO_STORE_BACKEND` forces it explicitly (fail-fast on an invalid value); otherwise auto — `REPL_ID` present ⇒ `replit`, else ⇒ `local`. Replit dev and prod both resolve to `replit` and share one bucket; no per-environment isolation is needed because they have **separate databases** and keys use a **unique random token**, so an operation in one environment can never touch the other's objects. The active backend is logged at boot (`initAudioStore` in `server.js`). Adding a third backend (S3/R2/GCS) = one new `buildXxxBackend()` in the adapter; routes, DB, UI and the retention GC (`scripts/audio-gc.mjs`) are untouched.

Mode is **re-synced with the current work configuration at two points**: (1) when a new session is created in `/s/:t/start`, and (2) on each `/s/:t/upload` (each upload is a fresh interview attempt — turnLog reset, etc.). Between these points, the mode is immutable for the in-flight interview. Professor changes affect: new students opening the link, students who haven't uploaded a PDF yet, and students who re-upload their PDF.

### Database
- **PostgreSQL**: Used for user authentication (bcrypt-hashed passwords in `users` table) and session management (`app_session` table via `connect-pg-simple`).
- `submissions.runtime_state_json` (JSONB) holds the in-flight interview snapshot for resume-after-restart. `runtime_state_json IS NULL` ⇔ "no in-flight attempt." Derived status is either `pending` (no upload) or `in_progress` (with upload/conversation).

### Authentication
- `bcrypt`: For hashing user passwords.
- `express-session`: For session management.
- `connect-pg-simple`: PostgreSQL store for sessions.
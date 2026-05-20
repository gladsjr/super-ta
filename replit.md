# TA-Assignment (SuperTA) – Production Architecture

## Overview
SuperTA is an assignment evaluation system that conducts a structured, stateful interview with students about their submitted work. Its primary purpose is to assess authorship, understanding, and conceptual coherence, moving beyond mere textual correctness. The system integrates a code-controlled state machine for orchestration, specialized AI agents for cognitive tasks like document analysis and per-turn signals (triage, sufficiency), and manages dual-state conversations (student-facing and internal evaluation). It also employs a two-layer document understanding approach using a global DocumentMap and local RAG.

## User Preferences
Not specified.

## System Architecture

### Architectural Principles
The system adheres to core rules: code orchestrates while AI agents analyze and propose; conversation history is separate from operational state; critical components fail fast without architectural fallbacks; runtime configuration has a single source of truth (`config/policy.yaml`); global understanding is achieved via a DocumentMap; local verification uses RAG (Vector Store); and internal evaluation is never exposed to the student.

### Project Structure
- `server.js`: Orchestration logic and agents.
- `auth.js`: Authentication.
- `static/index.html`: Frontend chat interface.
- `config/`: Contains `system_prompt.txt`, `policy.yaml`, `pricing.yaml`, `voices.js`, and the `interview_prompt_template.txt` / `interviewer_agenda_template.txt` templates.
- `data/submissions/`: Stores uploaded student files.

### Core Runtime Concepts

#### Dual Conversations
Each session maintains two independent conversational states:
- **Student Conversation (`conv_chat`)**: Visible to the student.
- **Evaluator Conversation (`conv_eval`)**: Contains internal analyses, signals, and document understanding, mirroring the visible chat for auditability.

#### Document Handling Strategy
Student documents are processed via:
- **Global View – DocumentMap**: Generated once by `MapBuilderAgent` from the full document (via `input_file` to Responses API). Provides a structured summary (thesis, structure, methodology, key claims, weak points) as compressed global context for downstream agents.
- **Local View – Vector Store (RAG)**: Full document indexed via OpenAI Vector Store, exposed as a `file_search` tool for per-turn agents (`AnswerSufficiencyAgent`, `ScopeClarificationAgent`, `OffTopicRedirectAgent`, `QuestionRelevanceAgent`) for evidence gathering grounded in the document.

#### Turn Dynamics
The system follows an invariant loop: Student responds → triage agents (scope/off-topic/meta) and the sufficiency agent run in parallel → if any triage wins, the answer is intercepted and sufficiency is aborted; otherwise sufficiency decides between `accept` (advance to next plan question) and `follow_up` (clarifying intervention) → SuperTA asks the next question. Evaluation only runs after student input.

#### Session Persistence
Each turn writes a single atomic `UPDATE` to `submissions` covering both `conversation_json` (the professor-facing log) and the runtime state needed to resume the interview after a server restart: `current_phase`, `question_index`, `frozen_interaction_mode`, `frozen_voice`, and `runtime_state_json` (a JSONB blob holding the OpenAI resource IDs, interview plan and document map). On `POST /s/:t/start` for a submission whose PDF is already in the DB, the server rehydrates the session, validates the four OpenAI resources (vector store, file, two conversations) in parallel, and reconstructs them from the student PDF if any have been deleted; the student sees a "Sessão recomposta" banner only in this rebuild path (text mode). `POST /s/:t/upload` rejects with 409 once an interview is in flight — to restart, the professor generates a new submission. `runtime_state_json IS NULL` is the canonical "no in-flight attempt" marker.

### Cognitive Agents
All agents are classes under `agents/` and utilize the Responses API, designed to fail fast. The active set: `MapBuilderAgent` and `PlanBuilderAgent` (one-shot on `/upload`), the triage trio (`ScopeClarificationAgent`, `OffTopicRedirectAgent`, `MetaInterventionAgent`) and `AnswerSufficiencyAgent` running in parallel on each student turn, plus `IntroductionAgent`, `QuestionRelevanceAgent`, `ConfigAssistantAgent` and `EnunciadoCoherenceAgent` for the professor-facing flows.

### Orchestration Model
The state machine resides in `server.js`. The orchestrator controls phase transitions, plan progression, per-turn agent invocation, and the public dialogue. AI agents provide signals and candidates but never control flow.

### Development Principles
- **When to Use Agents**: For reasoning over documents, structured outputs with validation, and complex cognitive tasks. Never for orchestration or simple text generation.
- **Error Handling**: Critical components fail explicitly; no silent degradation. Errors are architectural feedback.
- **Configuration**: One explicit configuration source (e.g., `config/policy.yaml`) is preferred over layered overrides or hidden defaults.

## External Dependencies

### OpenAI Integration
The system integrates with OpenAI using the following APIs:
- **Files API**: For uploading student documents.
- **Vector Stores API**: For indexing documents for RAG and `file_search`.
- **Conversations API**: To persist `conv_chat` and `conv_eval` server-side.
- **Responses API**: For all generation tasks, including DocumentMap creation, per-turn agent signals, and next-question generation.
- **Audio Transcriptions API** (STT): Converts student voice messages to text when the work is configured for audio mode.
- **Audio Speech API** (TTS): Generates the interviewer's voice response when the work is configured for audio mode.
The system uses `openai@^6.17.0` and does **not** use the Assistants API.

### Interaction Modes (text vs audio)
Each work is configured by the professor as either `text` (default) or `audio`. Mode is stored in `works.interaction_mode`; when audio, `works.voice` holds one of the fixed voices defined in `config/voices.js`.

**Critical principle: analysis is always done on text.** Audio is the "last-mile" interface with the student only:
- Inbound (student): voice → STT → text → identical pipeline as text mode.
- Outbound (interviewer): LLM-generated text → TTS → audio served to the student.
- All agents, document map, vector store and conversation log operate on text exclusively.

Audio is not persisted in the database. TTS output is cached per-session in memory (LRU of size 10) and served via `GET /s/:submissionToken/audio/:turnId`. On re-entry to an interview in audio mode, the student no longer sees the transcribed history — only the last interviewer audio is presented (reused from the in-memory cache when possible; regenerated via TTS once when the buffer is gone after a restart or LRU evict). This is intentional: visible transcripts make it trivial for the student to paste the question into an external LLM. Text mode is unaffected.

Mode is **re-synced with the current work configuration at two points**: (1) when a new session is created in `/s/:t/start`, and (2) on each `/s/:t/upload` (each upload is a fresh interview attempt — turnLog reset, etc.). Between these points, the mode is immutable for the in-flight interview. Professor changes affect: new students opening the link, students who haven't uploaded a PDF yet, and students who re-upload their PDF.

### Database
- **PostgreSQL**: Used for user authentication (bcrypt-hashed passwords in `users` table) and session management (`app_session` table via `connect-pg-simple`).
- `submissions.runtime_state_json` (JSONB) holds the in-flight interview snapshot for resume-after-restart. `runtime_state_json IS NULL` ⇔ "no in-flight attempt." Derived status is either `pending` (no upload) or `in_progress` (with upload/conversation).

### Authentication
- `bcrypt`: For hashing user passwords.
- `express-session`: For session management.
- `connect-pg-simple`: PostgreSQL store for sessions.
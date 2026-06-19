# ORATIA – Production Architecture

## Overview
ORATIA is an assignment evaluation system that conducts a structured, stateful interview with students about their submitted work, assessing authorship, understanding, and conceptual coherence (not just textual correctness).

Per-turn orchestration is **delegated to a single reasoning-model call** (`SuperOrchestratorAgent`) that receives full context and returns a JSON action. The code is a dispatcher around that decision with hard guardrails (turn cap, early-finalize block). This replaced an earlier triage×3 + sufficiency + relevance fleet.

Deep detail lives in `docs/architecture.md` and `docs/super-orchestrator-plan.md` (rationale + action schema).

## User Preferences
Not specified.

## System Architecture

### Architectural Principles
- Critical components fail fast — no architectural fallbacks; errors are feedback.
- Single source of truth for runtime config (`config/policy.yaml`).
- Per-turn cognitive load is concentrated in one reasoning call with code-side guardrails.
- Pre-interview prep (work analysis + plan) is generated once, upfront.
- Local verification of student claims uses RAG (Vector Store via `file_search`).
- Internal evaluation is never exposed to the student.

### Project Structure
- `routes/interview.js`: Student-facing endpoints (`/start`, `/upload`, `/chat`, `/audio`, `/finalize`, `/intro/advance`). `/chat` dispatches by phase: `intro` → `IntroductionAgent`; `interviewing` → `SuperOrchestratorAgent`.
- `routes/work.js`: Professor-facing endpoints (info, conversation, interviewer config, evaluation + student-version + sections + publish, feedback settings, grades, batch evaluate/generate/publish, submission management).
- `routes/admin.js`: Admin endpoints (works, users).
- `agents/`: All agent classes (see Cognitive Agents below).
- `lib/`: Shared infrastructure (db, session lifecycle/state, conversation utils, audio, audioStore, billing, middleware, deliverySignals, rubric, superOrchestrator/actionSchema).
- `config/`: `policy.yaml`, `pricing.yaml`, `voices.js`, prompt/agenda templates, `interviewers/*.yaml`.
- `static/`: Frontend HTML (`student.html`, `professor.html`, `admin.html`, `conversation.html`, `student_instructions.html`).
- `migrations/`: SQL migrations, file-per-change (see CLAUDE.md).

### Core Runtime Concepts

**Dual conversations** (OpenAI Conversations API): `conv_chat` (student-visible; the super-orchestrator reads it via the `conversation` param for full history) and `conv_eval` (professor-facing audit trail with extra metadata).

**Document handling**: on `/upload`, `PrepBuilderAgent` produces a global `work_analysis` and an `interview_plan` from both PDFs (student + assignment). Both PDFs are also indexed in a per-session Vector Store exposed as `file_search` for per-turn evidence.

**Turn dynamics** (`interviewing` phase): STT (audio mode) → intelligibility pre-gate → push student message → `SuperOrchestratorAgent` call (returns `rationale`, `action.kind` ∈ ask/follow_up/meta_modal/hint/finalize/ask_repeat, updated `memory`) → dispatcher does the I/O. Turn caps derive from `works.question_count` (3–20, default 6): force-finalize at `questions × 3`, block early finalize below `⌈questions / 2⌉`. Invalid output or failure falls back to `ask_repeat`. Audio mode streams SSE (`thinking` → `responding` → `result`).

**Session persistence**: each turn writes one atomic `UPDATE` to `submissions` (conversation log + runtime state for resume-after-restart in `runtime_state_json`). On `/s/:t/start` with an existing PDF, the server rehydrates and revalidates/rebuilds the OpenAI resources. `runtime_state_json IS NULL` ⇔ "no in-flight attempt."

### Cognitive Agents
All are classes under `agents/`, use the Responses API, and fail fast.
- **`PrepBuilderAgent`** — one-shot on `/upload`: `analyzeWork` then `buildPlan`.
- **`IntroductionAgent`** — three deterministic intro beats; adds a "spontaneity contract" when `works.expect_spontaneous` is set.
- **`AudioIntelligibilityAgent`** — phrases the audio pre-gate's repeat/give-up message (decision is algorithmic in `lib/audioIntelligibility.js`).
- **`SuperOrchestratorAgent`** — one reasoning call per turn; replaces the legacy per-turn fleet.
- **`ConfigAssistantAgent`** / **`EnunciadoCoherenceAgent`** — professor-facing config chat and assignment-statement evaluator.
- **`InterviewEvaluatorAgent`** — post-interview internal evaluation (content + a delivery section fed by `lib/deliverySignals.js`). Reports authorship/delivery evidence for the professor to weigh; never auto-accuses; never shown to the student.
- **`StudentFeedbackAgent`** — derives sanitized, formative student-facing feedback from the internal evaluation. Strips grades/forensics; professor is sovereign over content; the inviolable rule is "never impute cause / accuse." Two-layer sanitization (prompt rules + `FORBIDDEN_PATTERNS` code sweep).
- **`GradingAgent`** — 0–10 grade per rubric criterion (one LLM call per criterion); final grade is a weighted average computed in code (`lib/rubric.js`). The grade is its OWN publication (`submissions.grade_published_at`), independent of the devolutiva: compute (`/evaluation/grades`, batch `/evaluations/grades`) → publish separately (`/evaluation/grade-publish`, batch `/evaluations/grade-publish`). Professor-only until published; justifications never reach the student.

Devolutiva flow: generate preview → professor reviews/edits → publish (`evaluation_published_at`). Per-section visibility (interviewer opinion, strengths, improvement areas, study suggestions) is independent of generation. The GRADE is decoupled: a separate artifact published via `grade_published_at` — so the professor can publish the subjective devolutiva first, read the student's comment, then compute/publish the grade (or do it all at once). Students read whatever is published (devolutiva and/or grade, independently) at `GET /s/:submissionToken/evaluation`.

### Orchestration Model
The state machine is in `routes/interview.js`. Code owns phase transitions and guardrails; inside `interviewing` the super-orchestrator decides everything else. The action JSON is the contract; the dispatcher only does I/O.

### Multi-agent scenarios (MOCK — experimental, in validation)
A separate, self-contained subsystem at `/scenarios` (page `static/scenarios.html`, router `routes/scenarios.js`, logic in `lib/scenarios/`). Domain model (validated in the mock phase):
- **CENÁRIO** — the single top-level unit (what the PDF/enunciado explains): name + general explanation + a-posteriori PDF (with a "evaluate PDF×cenário coherence" action) + an **ordered sequence of interactions**. There is no library of cenários — one cenário.
- **INTERAÇÃO** — each ordered encounter: `student` (aluno↔1 or aluno↔N personas, with roles entrevista/discussão/questionamento) OR `persona_exchange` (first-class: 2 personas + a "focus" of what they discuss). Objective types: diagnóstico/negociação/apresentação/feedback/avaliação/discussão. (Sync/async was dropped from the UI.)
- **TEMPLATE** — reusable persona library (full definition, including **voice and gender** → destined for the future persona.yaml). IDs `t_*`.
- **PERSONAS DO CENÁRIO** — editable COPIES instantiated from templates (or created blank) for this cenário, with `template_id` provenance; editing them does not affect the template. IDs `cp_*`. Interactions reference THESE (not templates).

Form-based "studio" (no YAML), three tabs in authoring order — **🎬 Cenário** (explanation + PDF + a placeholder for the future professor config assistant) · **🎭 Personas** (selected personas on top + template library below, "+ Usar no cenário" copies one in) · **↔️ Interações** (the ordered, collapsible interaction builder) — plus a global Save/Test bar. The mock runner is an inline page mirroring the student view: one tab per interaction, unlocking sequentially, with a professor-only "generate student answer (mock)" control.

**Two execution modes.** `lib/scenarios/mockEngine.js` fabricates the SHAPE of a run by SCRIPTED templates (zero LLM, zero tokens) — used by the studio's "Testar" by default and for cost-free UI preview. The REAL engine (`?mode=live`) is `lib/scenarios/liveEngine.js` driving the `ScenarioOrchestratorAgent` (one reasoning call/turn: picks which persona speaks + the line; `persona_exchange` generates the 2–4 line exchange; guardrails — valid speaker via name→id normalization, per-interaction turn cap, deterministic run memory — live in code, not the LLM). Per-interaction context is rendered by `lib/scenarios/agenda.js` (+ `config/scenario_persona_template.txt`, `scenario_interaction_template.txt`), the analogue of `renderInterviewerAgenda`. The studio has an "IA real" toggle.

**Built and verified in text/browser (this validation pass):** the live orchestrator (conversation quality judged 4–5/5 across a 6-scenario matrix via `tests/scenario-eval.mjs`: a simulated student + LLM-judge, hard cost cap), the **`ScenarioAssistantAgent`** (professor's studio assistant — proposes cenário/personas/interações in natural language, never saves), and the **`ScenarioEvaluatorAgent`** (internal evaluation of a multi-interaction run; grades reuse the existing `GradingAgent` over its report). Cost-quality harness: `node tests/scenario-eval.mjs [--evaluate]` (text-only; `--max-usd` cap).

**Still pending (needs the local Postgres + app, currently blocked while Docker is down):** migrate the JSON store (`data/scenarios/`, gitignored) to Postgres and attach a cenário to a `work`; wire the real student token flow (the tabbed multi-interaction page with persistence/resume + SSE streaming of the persona line, as in `/chat`); gate `/scenarios` behind auth; the devolutiva (`StudentFeedbackAgent`) needs a small report-shape adaptation; PDF prep + vector store (`file_search`). Dev-only runner without DB: `scenarios-dev.mjs` (port 5096, gitignored; loads dotenv so `?mode=live` works). **Before any merge-to-main/Publish**: gate `/scenarios` behind auth and migrate the store to Postgres, or it ships unguarded.

## External Dependencies

### OpenAI Integration
`openai@^6.17.0`; **no** Assistants API. APIs used: Files (upload both PDFs), Vector Stores (per-session, `file_search`), Conversations (`conv_chat`/`conv_eval`, server-side compaction), Responses (all generation; `stream: true` for audio-mode `/chat`), Audio Transcriptions/STT (with logprobs for the pre-gate), Audio Speech/TTS (interviewer voice).

### Interaction Modes (text vs audio)
Per work: `text` (default) or `audio` (`works.interaction_mode`; `works.voice` from `config/voices.js`). **Analysis is always on text** — audio is the last-mile interface only (inbound voice → STT → text; outbound text → TTS). Mode is re-synced with the work config at `/s/:t/start` and each `/s/:t/upload`, immutable in between.

Interviewer (TTS) audio is **not persisted** (in-memory LRU, served via `GET /s/:submissionToken/audio/:turnId`); on re-entry the student sees only the last interviewer audio, deliberately (prevents pasting the question into an external LLM). Student inbound audio **is** archived (LGPD self-access + audit): bytes to object storage under `audio/{submission_token}/{audio_idx}.{ext}`, metadata in `student_audio_artifacts`. Archiving is best-effort. Backend is a single adapter (`lib/audioStore.js`): `local` (filesystem) or `replit` (Object Storage), selected by `AUDIO_STORE_BACKEND` or auto (`REPL_ID` ⇒ `replit`). Dev and prod share one bucket safely (separate DBs + random-token keys). Retention GC: `scripts/audio-gc.mjs`.

### Database
- **PostgreSQL**: user auth (bcrypt in `users`) and sessions (`app_session` via `connect-pg-simple`).
- `submissions.runtime_state_json` (JSONB) holds the in-flight snapshot; `NULL` ⇔ no in-flight attempt. Derived status: `pending` (no upload) or `in_progress`.

### Authentication
- `bcrypt` (password hashing), `express-session`, `connect-pg-simple` (PostgreSQL session store).

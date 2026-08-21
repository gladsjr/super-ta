# ORATIA – Production Architecture

## Overview
ORATIA is an assignment evaluation system that conducts a structured, stateful interview with students about their submitted work, assessing authorship, understanding, and conceptual coherence (not just textual correctness). A second work kind (`oral_realtime`) conducts a spoken, camera-on **oral exam** over the Realtime API against a professor-supplied gabarito.

The interview kind has two variants (`works.interview_variant`, migration 050): **`messages`** (deep — the per-turn reasoning orchestrator below) and **`realtime`** (simplified — a live-voice, camera-on Realtime session that asks ONLY the prepped plan questions; student screens mirror the oral exam; professor config and the evaluation pipeline are the SAME as the message interview — the transcript is converted to `conversation_json` at session close). Realtime-variant pieces: `routes/interviewLive.js`, `lib/liveInterview.js`, `lib/liveConversation.js`, `static/live-student.html`; the generic relay engine shared with the oral exam lives in `lib/realtimeBridge.js`.

Per-turn orchestration is **delegated to a single reasoning-model call** (`SuperOrchestratorAgent`) that receives full context and returns a JSON action; the code is a dispatcher around that decision with hard guardrails (turn cap, early-finalize block). This replaced an earlier triage×3 + sufficiency + relevance fleet.

**Keep this file lean.** Start at [`docs/README.md`](docs/README.md) — it maps every
genre of documentation and its lifecycle. What the product *does*, in business
terms, lives in [`docs/capacidades/`](docs/capacidades/README.md); *why* things are
the way they are lives in [`docs/decisoes/`](docs/decisoes/README.md) (ADRs).

Subsystem detail lives in `docs/` — update THERE when a subsystem changes:
- `docs/architecture.md` — `/chat` cycle + prompt map (mermaid)
- `docs/super-orchestrator-plan.md` — rationale + action schema
- `docs/oral-exam.md` — oral exam (Realtime): relay, guaranteed ending, setup gate, calibration, proctoring, oral agents, schema
- `docs/video-proctoring.md` — camera-on "fiscalização" for the message interview (command areas; vídeo OBRIGATÓRIO/bloqueante — gate `static/js/proctorGate.js`, estado `awaiting_video`, liberação do professor)
- `docs/scenarios.md` — multi-agent scenarios subsystem (experimental)
- `docs/access-model.md` — camada institucional: unidades (árvore recursiva + flag de turma), RBAC tenant-aware (herança só p/ admin; disponibilidade ≠ acesso), identidade/login (pessoa ≠ identidades; local + Google SSO), dois portões de uso como reserva (US$ + pacotes/DSL, com devolução), integração gradual

## User Preferences
- Timezone: America/Sao_Paulo (GMT-3, Rio de Janeiro). Sempre converter horários de logs (UTC) para GMT-3 ao falar com o usuário.
- Comunicação em português, formato escaneável; usuário não usa Shell nem copia-colar para o Shell.

## System Architecture

### Architectural Principles
- Critical components fail fast — no architectural fallbacks; errors are feedback.
- Single source of truth for runtime config (`config/policy.yaml`).
- Per-turn cognitive load concentrated in one reasoning call; guardrails in code.
- Pre-interview prep (work analysis + plan) generated once, upfront.
- Local verification of student claims uses RAG (per-session Vector Store via `file_search`).
- Internal evaluation is never exposed to the student.

### Project Structure
- `routes/interview.js` — student endpoints (`/start`, `/upload`, `/chat`, `/audio`, `/finalize`, `/intro/advance`); owns the state machine. Phase dispatch: `intro` → `IntroductionAgent`; `interviewing` → `SuperOrchestratorAgent`.
- `routes/work.js` — professor endpoints (conversation, evaluation + student-version + publish, feedback settings, grades, batches, submission management).
- `routes/admin.js` — admin (works, users). `routes/oralExam.js` — oral-exam professor + student endpoints.
- `routes/units.js` — camada institucional: unidades (árvore + turma), papéis (memberships/roles), disponibilidade, teto US$ por unidade (reserva), pacotes (alocação/cascata/devolução + leitura). `routes/authFederated.js` — login federado (Google OIDC, opcional). Detalhe em `docs/access-model.md`.
- `agents/` — all agent classes (Responses API, fail fast).
- `lib/` — shared infra (db, session lifecycle/state, conversation utils, audio + audioStore, billing, middleware, deliverySignals, rubric, superOrchestrator/actionSchema; `oralRealtime` = Realtime relay, `proctor` = video proctoring (streaming frame extraction), `proctorQueue` = global analysis queue (configurable concurrency, admin Operações); `units`/`rbac`/`packages` = camada institucional — árvore, RBAC tenant-aware, DSL+cotas de pacote).
- `config/` — `policy.yaml`, `pricing.yaml`, `voices.js`, prompt/agenda templates, `interviewers/*.yaml`, `packages/*.yaml` (DSL de pacotes — controle de uso).
- `static/` — frontend HTML per audience (`student/professor/admin/conversation/student_instructions` + `oral-*` variants; MediaPipe WASM self-hosted in `static/vision/`).
- `migrations/` — SQL, file-per-change (conventions in CLAUDE.md).

### Core Runtime Concepts
- **Dual conversations** (OpenAI Conversations API): `conv_chat` (student-visible; the orchestrator reads it via the `conversation` param) and `conv_eval` (professor-facing audit trail).
- **Prep**: on `/upload`, `PrepBuilderAgent` produces `work_analysis` + `interview_plan` from both PDFs (student + assignment); both PDFs are also indexed in a per-session Vector Store exposed as `file_search`.
- **Turn dynamics** (`interviewing`): STT (audio mode) → intelligibility pre-gate → orchestrator call (`rationale`, `action.kind` ∈ ask/follow_up/meta_modal/hint/finalize/ask_repeat, updated `memory`) → dispatcher does the I/O. Turn caps from `works.question_count` (3–20, default 6): force-finalize at `questions × 3`, early finalize blocked below `⌈questions/2⌉`. Invalid output ⇒ `ask_repeat`. Audio mode streams SSE (`thinking` → `responding` → `result`).
- **Session persistence**: each turn writes one atomic `UPDATE` to `submissions` (`runtime_state_json` = in-flight snapshot for resume-after-restart; `NULL` ⇔ no in-flight attempt). `/s/:t/start` rehydrates and revalidates/rebuilds OpenAI resources.

### Cognitive Agents (one line each — oral detail in `docs/oral-exam.md`)
- `PrepBuilderAgent` — one-shot on `/upload`: `analyzeWork` then `buildPlan`.
- `IntroductionAgent` — three deterministic intro beats (+ "spontaneity contract" when `works.expect_spontaneous`).
- `AudioIntelligibilityAgent` — phrases the audio pre-gate message (decision is algorithmic, `lib/audioIntelligibility.js`).
- `SuperOrchestratorAgent` — the one reasoning call per turn.
- `ConfigAssistantAgent` / `EnunciadoCoherenceAgent` — professor config chat + assignment-statement evaluator.
- `InterviewEvaluatorAgent` — post-interview internal evaluation (+ delivery section from `lib/deliverySignals.js`); never auto-accuses, never shown to the student.
- `StudentFeedbackAgent` — sanitized, formative student devolutiva derived from the internal eval (two-layer sanitization: prompt rules + `FORBIDDEN_PATTERNS` sweep); reused for the oral devolutiva.
- `GradingAgent` — 0–10 per rubric criterion (one call per criterion); final = weighted average in code (`lib/rubric.js`). The grade is its OWN publication (`grade_published_at`), independent of the devolutiva.
- *(removed 2026-08-13)* Automatic grade penalty (`GradePenaltyAgent`): proctoring is a human-review signal, never an automatic accusation. Video alerts are now only shown to the professor (who adjusts the grade manually) and may color the student devolutiva; the grade is just the weighted rubric average.
- Oral pipeline: `OralExamExtractorAgent`, `OralRubricBuilderAgent`, `OralExamEvaluatorAgent`, `OralCalibrationAgent` — see `docs/oral-exam.md`.

**Devolutiva flow**: generate preview → professor reviews/edits → publish (`evaluation_published_at`), with independent per-section visibility; the grade is computed and published separately (professor can publish devolutiva first, read the student's comment, then the grade). Students read whatever is published at `GET /s/:submissionToken/evaluation`.

## External Dependencies

### OpenAI
`openai@^6.x`; **no** Assistants API. APIs used: Files, Vector Stores (per-session `file_search`), Conversations (`conv_chat`/`conv_eval`, server-side compaction), Responses (all generation; `stream: true` for audio-mode `/chat`), STT (with logprobs for the pre-gate), TTS (interviewer voice), Realtime (`gpt-realtime`, oral relay).

**STT provider layer (#284)**: fala do aluno passa por `lib/stt.js#sttTranscribe` (única porta de entrada — não chame `audio.transcriptions.create` direto). Provedores: `openai` (gpt-transcribe, padrão) e `groq` (whisper-large-v3, dormente até haver `GROQ_API_KEY` + aditivo LGPD #290). Config em `policy.yaml#models.stt_*`: fallback automático por chamada, timeout (só com fallback), sombra amostral p/ comparação. O /audio do modo mensagem passa um GLOSSÁRIO por trabalho (#293, `lib/sttGlossary.js` — extração mecânica de siglas/nomes do plano+análise; a calibração NÃO recebe glossário, ela mede a captação). Provedor configurado sem credencial/preço derruba o boot (ADR 0002).

**Model selection**: `config/policy.yaml#models` is the source of truth (`principal_reasoning_model` for analysis/orchestration/evaluation, `fast_model` for extraction/phrasing; `principal_reasoning_effort` injected uniformly by `lib/openaiClient.js`). Don't hardcode model names in docs — check policy.yaml.

### Interaction Modes (text vs audio)
Per work: `text` (default) or `audio` (`works.interaction_mode`; voice from `config/voices.js`). **Analysis is always on text** — audio is last-mile only (STT in, TTS out); mode re-synced at `/start` and `/upload`, immutable in between. Interviewer TTS is **not persisted** (in-memory LRU; on re-entry only the last audio — deliberate anti-leak). Student inbound audio **is** archived (LGPD): object storage via `lib/audioStore.js` (`local` | `replit`, auto by `REPL_ID`; dev and prod share one bucket safely — separate DBs + random-token keys), metadata in `student_audio_artifacts`, GC in `scripts/audio-gc.mjs`.

### Database & Auth
- **PostgreSQL**: app data; auth (`bcrypt` in `users`), sessions (`app_session` via `connect-pg-simple`).
- `submissions.runtime_state_json` (JSONB) = in-flight snapshot; derived status: `pending` (no upload) or `in_progress`.

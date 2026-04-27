# TA-Assignment (SuperTA) – Production Architecture

## Overview
SuperTA is an assignment evaluation system that conducts a structured, stateful interview with students about their submitted work. Its primary purpose is to assess authorship, understanding, and conceptual coherence, moving beyond mere textual correctness. The system integrates a code-controlled state machine for orchestration, specialized AI agents for cognitive tasks like document analysis and evaluation, and manages dual-state conversations (student-facing and internal evaluation). It also employs a two-layer document understanding approach using a global DocumentMap and local RAG.

## User Preferences
Not specified.

## System Architecture

### Architectural Principles
The system adheres to core rules: code orchestrates while AI agents analyze and propose; conversation history is separate from operational state; critical components fail fast without architectural fallbacks; runtime configuration has a single source of truth (`config/policy.yaml`); global understanding is achieved via a DocumentMap; local verification uses RAG (Vector Store); and internal evaluation is never exposed to the student.

### Project Structure
- `server.js`: Orchestration logic and agents.
- `auth.js`: Authentication.
- `static/index.html`: Frontend chat interface.
- `config/`: Contains `assignment.json`, `rubric.json`, `system_prompt.txt`, and `policy.yaml`.
- `data/submissions/`: Stores uploaded student files.

### Core Runtime Concepts

#### Dual Conversations
Each session maintains two independent conversational states:
- **Student Conversation (`conv_chat`)**: Visible to the student.
- **Evaluator Conversation (`conv_eval`)**: Contains internal analyses, signals, and document understanding, mirroring the visible chat for auditability.

#### Document Handling Strategy
Student documents are processed via:
- **Global View – DocumentMap**: Generated once by `MapBuilderAgent` from the full document (via `input_file` to Responses API). Provides a structured summary (thesis, structure, methodology, key claims, weak points) as compressed global context for evaluators.
- **Local View – Vector Store (RAG)**: Full document indexed via OpenAI Vector Store, exposed as a `file_search` tool for `ComprehensionEvaluatorAgent`, `ClarificationEvaluatorAgent`, and `generateNextQuestion()` for evidence gathering and grounded question generation.

#### Turn Dynamics
The system follows an invariant loop: Student responds -> Response stored -> Internal evaluators run -> Signals consolidated -> Orchestrator decides next action -> SuperTA asks next question. Evaluation only runs after student input.

### Cognitive Agents
All agents are classes under `agents/` and utilize the Responses API, designed to fail fast.
- **MapBuilderAgent**: Generates the structured DocumentMap. Must succeed for system operation.
- **ComprehensionEvaluatorAgent**: Assesses student understanding using `file_search`. Maps to Rubric C1.
- **ClarificationEvaluatorAgent**: Identifies unclear aspects requiring targeted questions, using `file_search`.

### Orchestration Model
The state machine resides in `server.js`. The orchestrator controls question count, follow-up thresholds, evaluator invocation, and public dialogue. AI agents provide signals and candidates but never control flow.

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
- **Responses API**: For all generation tasks, including DocumentMap creation, evaluator signals, next questions, and scoring.
The system uses `openai@^6.17.0` and does **not** use the Assistants API.

### Database
- **PostgreSQL**: Used for user authentication (bcrypt-hashed passwords in `users` table) and session management (`app_session` table via `connect-pg-simple`).

### Authentication
- `bcrypt`: For hashing user passwords.
- `express-session`: For session management.
- `connect-pg-simple`: PostgreSQL store for sessions.
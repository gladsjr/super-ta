-- 004_add_runtime_state.sql
-- Persistência de sessão para retomar a entrevista após restart do servidor.
--
-- Antes desta migration o estado de runtime (IDs OpenAI, plano de perguntas,
-- documentMap, currentPhase, questionIndex, modo congelado, etc.) vivia só no
-- Map SESSIONS em memória; qualquer reinício do processo derrubava a entrevista
-- em andamento. Agora persistimos esse estado a cada turno.
--
-- Convenção: runtime_state_json IS NULL  ⇔  "sem tentativa em andamento".
-- Quando o aluno faz /upload começa a preencher; em /finalize é limpado.
-- conversation_json (visível ao professor) continua o que era.

ALTER TABLE submissions
  ADD COLUMN current_phase            TEXT,
  ADD COLUMN question_index           INTEGER,
  ADD COLUMN frozen_interaction_mode  TEXT,
  ADD COLUMN frozen_voice             TEXT,
  ADD COLUMN runtime_state_json       JSONB;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_current_phase_chk
    CHECK (current_phase IS NULL OR current_phase IN
           ('awaiting_upload','intro','interviewing','finalizing')),
  ADD CONSTRAINT submissions_frozen_mode_chk
    CHECK (frozen_interaction_mode IS NULL
        OR frozen_interaction_mode IN ('text','audio')),
  ADD CONSTRAINT submissions_question_index_chk
    CHECK (question_index IS NULL OR question_index >= 0);

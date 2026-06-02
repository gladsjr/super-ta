-- 009_student_audio_artifacts.sql
-- Metadados das gravações de áudio do aluno. Os bytes vivem no Replit Object
-- Storage (App Storage / GCS sob o capô) sob a chave `object_key`. Apenas o
-- áudio DO ALUNO é guardado — voz do entrevistador é TTS e regerável do texto.
--
-- A relação por submission_id usa ON DELETE CASCADE pra alinhar com o resto
-- da retenção: remover a submission limpa os metadados; um job paralelo
-- (scripts/audio-gc.mjs) cuida de remover os objetos órfãos no bucket.

CREATE TABLE student_audio_artifacts (
    id                 SERIAL PRIMARY KEY,
    submission_id      INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    audio_idx          INTEGER NOT NULL,
    turn_index         INTEGER,
    intervention_index INTEGER,
    object_key         TEXT NOT NULL UNIQUE,
    mimetype           TEXT,
    byte_size          INTEGER,
    duration_s         NUMERIC(8, 2),
    sha256             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX student_audio_artifacts_submission_idx
    ON student_audio_artifacts (submission_id, audio_idx);

-- Versão do termo de consentimento aceita pelo aluno. NULL = consentimento
-- aceito antes da introdução do versionamento (legado, sem gravação).
ALTER TABLE submissions
    ADD COLUMN consent_version TEXT;

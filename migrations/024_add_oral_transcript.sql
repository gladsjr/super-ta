-- Prova oral (Realtime): transcrição da conversa (examinador + aluno) capturada
-- no servidor SÓ como registro (não vai ao aluno; não há legenda ao vivo). Serve
-- para a AVALIAÇÃO comparar as respostas faladas do aluno com o gabarito.
-- Formato: JSONB [{ role: 'examiner'|'student', text }].
ALTER TABLE submissions ADD COLUMN oral_transcript JSONB;

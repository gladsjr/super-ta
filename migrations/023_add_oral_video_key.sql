-- Prova oral (Realtime): a câmera do aluno é gravada e guardada no object
-- storage para avaliação posterior. Guardamos a CHAVE do objeto na submissão
-- (NULL = sem vídeo ainda). O vídeo em si NÃO vai à OpenAI.
ALTER TABLE submissions ADD COLUMN oral_video_key TEXT;

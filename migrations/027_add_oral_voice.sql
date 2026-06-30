-- Sinalizadores de "cola" por VOZ (para revisão humana, nunca acusação):
-- latência de resposta (capturada ao vivo pelo relay) e, depois, segunda voz /
-- voz sintética (análise pós-prova do áudio). JSON com chaves mescladas.
ALTER TABLE submissions ADD COLUMN oral_voice_json JSONB;

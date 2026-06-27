-- Resultado do proctoring local por vídeo (flags para revisão humana):
-- ausência, mais de uma pessoa, celular, mãos não visíveis. JSON gerado por
-- lib/proctor.js (modelos YOLOv8n locais). Nunca é acusação automática.
ALTER TABLE submissions ADD COLUMN oral_proctor_json JSONB;

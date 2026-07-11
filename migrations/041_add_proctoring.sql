-- Proctoring por vídeo na ENTREVISTA POR MENSAGEM (opt-in do professor).
-- Ativar implica modo áudio (respostas por voz) — o aluno fica longe do teclado e
-- comanda por gesto. A frase de calibração de fala da entrevista REAPROVEITA a coluna
-- works.oral_calibration_json (migration 040); aqui só entram o opt-in e o prompt
-- (opcional) que o professor usa para ajustar a menção do proctoring na devolutiva.
ALTER TABLE works ADD COLUMN proctoring_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE works ADD COLUMN devolutiva_proctor_prompt TEXT;

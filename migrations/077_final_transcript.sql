-- Transcrição FINAL (retranscrição de auditoria) — issue #289, Fase 3.
--
-- Contrato transcript_live × transcript_final (estratégia do conselho, 21/08):
-- o transcript ao vivo do relay é OPERACIONAL (retomada, alertas, revisão
-- imediata) e degrada quando o áudio degrada — 10 de 11 sessões realtime da
-- turma 2026-2 saíram corrompidas nele. A retranscrição do áudio CONTÍNUO do
-- tee (lib/audioTee.js) recupera o conteúdo (bancada #285: a sessão 100%
-- alucinada virou português íntegro no MESMO provedor) e vira o registro de
-- AUDITORIA — nesta fase em CONVIVÊNCIA: gravada e exibida ao professor, sem
-- ainda substituir a fonte da avaliação (o flip tem critério de saída próprio).
--
-- JSONB { mode, text, provider, model, tee: { key, duration_s, marcas } }.
ALTER TABLE submissions
    ADD COLUMN final_transcript JSONB,
    ADD COLUMN final_transcript_at TIMESTAMPTZ;

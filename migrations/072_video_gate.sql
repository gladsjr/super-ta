-- Gate de vídeo OBRIGATÓRIO do proctoring (torna o proctoring de vídeo
-- bloqueante — antes era best-effort/fail-open). Duas flags por submissão:
--
--   awaiting_video: a sessão de arguição encerrou de fato (o aluno concluiu),
--     mas o vídeo OBRIGATÓRIO ainda não chegou ao servidor. Enquanto true, a
--     submissão NÃO é marcada como concluída (completion_reason fica NULL) — o
--     status derivado vira 'awaiting_video'. A promoção para 'complete' acontece
--     quando o vídeo chega (endpoints de upload chamam promoteAwaitingVideo).
--     Evita "concluída sem vídeo" nos fluxos por voz, onde a conclusão é marcada
--     no encerramento da sessão, ANTES de o vídeo subir.
--
--   video_waived: o professor liberou ESTE aluno a concluir SEM vídeo — válvula
--     de escape para incompatibilidade real de câmera/navegador (o gate barra o
--     início; o professor libera caso a caso).
ALTER TABLE submissions ADD COLUMN awaiting_video BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN video_waived BOOLEAN NOT NULL DEFAULT false;

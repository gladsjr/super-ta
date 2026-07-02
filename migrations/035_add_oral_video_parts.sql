-- Segmentos de vídeo da prova oral (multi-parte).
-- Antes: uma chave única (oral_video_key), SOBRESCRITA a cada (re)conexão — uma
-- RETOMADA após queda perdia os segmentos anteriores. Agora cada segmento é
-- preservado; a lista ordenada de chaves fica aqui. oral_video_key segue existindo
-- e aponta para o ÚLTIMO segmento (compat com has_oral_video e código legado).
ALTER TABLE submissions ADD COLUMN oral_video_parts JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: provas que já têm um vídeo viram uma lista de 1 parte.
UPDATE submissions SET oral_video_parts = jsonb_build_array(oral_video_key) WHERE oral_video_key IS NOT NULL;

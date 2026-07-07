-- Prova oral: modelo único de nota por RUBRICA detalhada. Antes cada questão tinha
-- um único 2º campo (`answer`) cujo significado dependia de oral_grading_mode
-- (resposta esperada no determinístico; critério no rubrica). Agora cada questão
-- tem `answer` (resposta esperada, opcional, insumo p/ gerar a rubrica) E `rubric`
-- (o critério detalhado, obrigatório p/ avaliar) + `rubric_stale` (marca de revisão).
--
-- Migração preservando o conteúdo, por trabalho oral_realtime:
--   modo 'rubrica'        → o 2º campo JÁ é critério: rubric = answer, answer = ''.
--   modo 'deterministico' → o 2º campo é resposta: mantém answer, rubric = '' (pendente).
-- rubric_stale nasce false quando já há rubrica (modo rubrica) e true quando falta.
UPDATE works w
SET oral_questions = sub.newq
FROM (
    SELECT works.id,
           jsonb_agg(
               CASE WHEN works.oral_grading_mode = 'rubrica'
                    THEN (elem - 'answer')
                         || jsonb_build_object(
                                'rubric', COALESCE(elem->'answer', to_jsonb(''::text)),
                                'answer', to_jsonb(''::text),
                                'rubric_stale', to_jsonb(false)
                            )
                    ELSE elem
                         || jsonb_build_object(
                                'rubric', to_jsonb(''::text),
                                'rubric_stale', to_jsonb(true)
                            )
               END
               ORDER BY ord
           ) AS newq
    FROM works, jsonb_array_elements(works.oral_questions) WITH ORDINALITY AS t(elem, ord)
    WHERE works.kind = 'oral_realtime'
      AND works.oral_questions IS NOT NULL
      AND jsonb_typeof(works.oral_questions) = 'array'
    GROUP BY works.id
) sub
WHERE w.id = sub.id;

-- Config TRAVADA por pacote (Portão B). Quando um trabalho é criado sob um item
-- de pacote, o `locks` do item é a fonte da verdade da config daquele trabalho.
-- question_count / interaction_mode / interview_variant já existem em works;
-- estas são as travas que ainda não tinham coluna.
--
-- max_follow_ups: teto de follow-ups do orquestrador (NULL = orquestrador decide,
--   comportamento de hoje). Guardrail novo no dispatcher de /chat.
-- evaluation_mode: NULL/'full' = pipeline completo; 'automatic_only' = roda só o
--   avaliador interno (InterviewEvaluatorAgent), SEM devolutiva ao aluno e SEM
--   nota. (Prova oral com nota usa o modo de nota oral existente — migration 036.)
ALTER TABLE works ADD COLUMN max_follow_ups  INTEGER;
ALTER TABLE works ADD COLUMN evaluation_mode TEXT
  CHECK (evaluation_mode IS NULL OR evaluation_mode IN ('full','automatic_only'));

-- Binding do trabalho ao contador de pacote que ele saca no início da execução.
-- NULL em ambos = trabalho fora de pacote (token-only ou só orçamento US$).
ALTER TABLE works ADD COLUMN entitlement_template_key TEXT;
ALTER TABLE works ADD COLUMN entitlement_item_key     TEXT;

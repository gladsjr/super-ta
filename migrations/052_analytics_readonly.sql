-- Camada de ANÁLISE somente-leitura para consulta externa (benchmark).
--
-- Objetivo: expor dados de produção (custo, tokens, comportamento) para análise
-- externa via endpoint HTTP (routes/analytics.js), SEM expor PII direta nem
-- permitir escrita. O backstop de segurança é o Postgres, não o código do
-- endpoint: as consultas rodam numa transação READ ONLY, com search_path fixo
-- em `analytics`, então mesmo um bug no parser não escreve nem lê tabela-base.
--
-- Esta migration é 100% schema-level (schema + views + coluna + tabela) — logo é
-- carregada a produção pelo fluxo de Publish do Replit, sem passo manual. NÃO há
-- CREATE ROLE aqui de propósito: roles são objetos de cluster e não seriam
-- propagados pelo diff de schema do Publish; a garantia de não-escrita vem da
-- transação READ ONLY aplicada pelo endpoint.
--
-- Níveis de exposição (decisão do professor):
--   Nível 1 (métricas, sem PII): analytics.works, cost_events, submissions.
--   Nível 2 (conteúdo, opt-in do projeto): analytics.conversation_turns,
--            analytics.evaluations — texto real de resposta do aluno / avaliação
--            interna, SEM identificadores diretos (só submission_id opaco).
--
-- Opt-out por trabalho: works.analytics_opt_out = true remove o work (e suas
-- submissões/eventos/conversas) de TODAS as views.

-- 1) Opt-out por trabalho. Metadata-only (default) — rápido mesmo em tabela grande.
ALTER TABLE works ADD COLUMN analytics_opt_out BOOLEAN NOT NULL DEFAULT false;

-- 2) Schema isolado. Só recebe VIEWS — nenhuma tabela-base mora aqui.
CREATE SCHEMA analytics;

-- 3) Cast defensivo de TEXT->JSONB: conversation_json/grades_json são TEXT e
-- podem estar NULL ou (em teoria) malformados. Sem isto, um '::jsonb' cru
-- derrubaria a view inteira numa única linha inválida. Retorna NULL no erro.
CREATE FUNCTION analytics.try_jsonb(t text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
BEGIN
    IF t IS NULL OR btrim(t) = '' THEN RETURN NULL; END IF;
    RETURN t::jsonb;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$fn$;

-- ============================ NÍVEL 1 (sem PII) ============================

-- Trabalhos: metadados de configuração + orçamento/gasto. Nome e token são
-- autorados pelo professor (não são PII do aluno) e ajudam a identificar works
-- de benchmark. Respeita o opt-out.
CREATE VIEW analytics.works AS
SELECT id, work_token, name, kind, interview_variant, question_count,
       interaction_mode, is_benchmark, budget_usd, spent_usd, voice,
       proctoring_enabled, created_at
FROM works
WHERE NOT analytics_opt_out;

-- Telemetria fina de custo/tokens por chamada à OpenAI (a fonte central do
-- custo). submission_id/work_id são inteiros opacos, não PII.
CREATE VIEW analytics.cost_events AS
SELECT e.work_id, e.submission_id, e.event_type, e.model, e.agent_label,
       e.input_tokens, e.cached_tokens, e.output_tokens,
       e.audio_seconds, e.audio_chars, e.cost_usd, e.created_at
FROM work_cost_events e
JOIN works w ON w.id = e.work_id
WHERE NOT w.analytics_opt_out;

-- Submissões: SÓ métricas e status — nada de student_pdf, student_label,
-- oral_video_key ou texto cru. Turnos/entrada derivados do conversation_json.
CREATE VIEW analytics.submissions AS
SELECT s.id, s.work_id, s.is_test, s.is_blocked, s.completion_reason,
       s.current_phase, s.question_index, s.frozen_interaction_mode,
       s.grade_final, s.grade_published_at, s.evaluation_published_at, s.created_at,
       jsonb_array_length(COALESCE(analytics.try_jsonb(s.conversation_json) -> 'turns', '[]'::jsonb)) AS turn_count,
       (analytics.try_jsonb(s.conversation_json) ->> 'completed')::boolean AS completed,
       analytics.try_jsonb(s.conversation_json) ->> 'started_at' AS started_at
FROM submissions s
JOIN works w ON w.id = s.work_id
WHERE NOT w.analytics_opt_out;

-- ===================== NÍVEL 2 (conteúdo — opt-in) =====================

-- Turnos da entrevista por mensagem: texto do entrevistador (question) e do
-- aluno (answer). SÓ submission_id opaco — nunca o student_label (que fica no
-- topo do conversation_json e é deliberadamente NÃO exposto aqui).
CREATE VIEW analytics.conversation_turns AS
SELECT s.id AS submission_id, s.work_id,
       (t.turn ->> 'index')::int AS turn_index,
       t.turn ->> 'question' AS interviewer_text,
       t.turn ->> 'answer' AS student_text,
       t.turn ->> 'asked_at' AS asked_at,
       t.turn ->> 'answered_at' AS answered_at,
       (t.turn -> 'question_metadata' ->> 'spontaneous')::boolean AS spontaneous,
       t.turn -> 'question_metadata' ->> 'revisit_topic' AS revisit_topic
FROM submissions s
JOIN works w ON w.id = s.work_id,
     LATERAL jsonb_array_elements(
         COALESCE(analytics.try_jsonb(s.conversation_json) -> 'turns', '[]'::jsonb)
     ) AS t(turn)
WHERE NOT w.analytics_opt_out;

-- Avaliação interna (comportamento do avaliador/nota) — útil para investigar
-- fabricação/insistência. Sem identificadores diretos.
CREATE VIEW analytics.evaluations AS
SELECT s.id AS submission_id, s.work_id,
       s.evaluation_json AS evaluation,
       analytics.try_jsonb(s.grades_json) AS grades
FROM submissions s
JOIN works w ON w.id = s.work_id
WHERE NOT w.analytics_opt_out;

-- ============================ Auditoria ============================
-- Registro de TODA consulta feita pelo endpoint. Escrito pelo app (role dono),
-- fora da transação READ ONLY — o consumidor da API não o alcança.
CREATE TABLE analytics_query_log (
    id          BIGSERIAL PRIMARY KEY,
    actor       TEXT NOT NULL DEFAULT 'claude',
    mode        TEXT NOT NULL,                    -- 'named' | 'adhoc'
    query       TEXT NOT NULL,                    -- nome da consulta ou o SQL cru
    params_json JSONB,
    row_count   INT,
    truncated   BOOLEAN,
    duration_ms INT,
    ok          BOOLEAN NOT NULL,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_query_log_created_idx ON analytics_query_log (created_at DESC);

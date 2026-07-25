-- Entrevista em duas variantes: PROFUNDA (por mensagens, a existente — default)
-- e SIMPLIFICADA (tempo real, por voz via Realtime, estilo prova oral). O flag
-- vive no trabalho (kind continua 'interview'); a variante decide a página do
-- aluno e o motor da conversa. 'messages' = profunda; 'realtime' = simplificada.
ALTER TABLE works ADD COLUMN interview_variant TEXT NOT NULL DEFAULT 'messages';
ALTER TABLE works ADD CONSTRAINT works_interview_variant_chk CHECK (interview_variant IN ('messages', 'realtime'));

-- Preparação da entrevista simplificada: {analysis, plan, prepared_at,...} do
-- PrepBuilderAgent, gerada no upload do trabalho do aluno. Coluna própria (fora
-- do runtime_state_json, que pertence ao ciclo de vida do orquestrador da
-- entrevista por mensagens). NULL = ainda não preparada.
ALTER TABLE submissions ADD COLUMN live_prep_json JSONB;

-- Tokens do endpoint de análise (POST /api/analytics/query), GERADOS PELO ADMIN.
--
-- Substitui a autenticação por variável de ambiente (ANALYTICS_API_KEY) por
-- tokens criados na tela de administração por um usuário logado (que já tem
-- direito de acesso aos dados). Assim: (a) não precisa de Replit Secret; (b) o
-- acesso fica atrelado a um humano autorizado e rastreável (created_by); (c)
-- todo token EXPIRA em 30 dias (fixo, definido no INSERT).
--
-- Guardamos só o HASH (sha256) do token — o texto puro é mostrado UMA vez ao
-- admin no momento da geração e nunca mais. token_prefix é os primeiros
-- caracteres, só para identificação visual na lista.

CREATE TABLE analytics_tokens (
    id           BIGSERIAL PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,          -- sha256(hex) do token em texto puro
    token_prefix TEXT NOT NULL,                 -- primeiros chars, p/ exibição (não é segredo)
    label        TEXT,                          -- descrição opcional (ex.: "benchmark custo jul/26")
    created_by   TEXT,                          -- username do admin que gerou
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,          -- created_at + 30 dias (fixo)
    revoked_at   TIMESTAMPTZ                     -- revogação manual antecipada
);

-- Busca de autenticação: por hash, só os vivos (não revogados). Índice parcial.
CREATE INDEX analytics_tokens_hash_idx ON analytics_tokens (token_hash) WHERE revoked_at IS NULL;

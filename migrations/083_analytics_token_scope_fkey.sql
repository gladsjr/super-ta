-- FK do alcance do token (#375, corte 2, segunda parte). Separada da 082 de
-- propósito: o Publish do Replit materializa o schema ANTES de o boot semear
-- analytics_token_scopes. Se a FK viesse no mesmo diff que cria a tabela, ela
-- seria criada em produção com a tabela-alvo vazia e tokens já apontando para
-- 'analytics' — e falharia em silêncio (explicação mais provável para a FK da
-- 074, #389). Esta migration só é publicada depois de a 082 estar em produção
-- e o boot ter semeado os alcances (conferido pelo health check em 08/09).
-- Regra geral no AGENTS.md, seção de migrations.
ALTER TABLE analytics_tokens ADD CONSTRAINT analytics_tokens_scope_fkey
    FOREIGN KEY (scope) REFERENCES analytics_token_scopes(key);

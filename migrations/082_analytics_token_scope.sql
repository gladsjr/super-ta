-- Alcance (scope) do token de acesso programático (#375, corte 2).
--
-- O token de analytics_tokens nasceu para UM uso: o endpoint de análise, que é
-- somente-leitura por construção (transação READ ONLY). O endpoint de saúde
-- passou a aceitá-lo também, e o nível `deep` do health check vai escrever no
-- storage e gastar dinheiro. Reaproveitar o mesmo token sem qualificação
-- ampliaria, em silêncio, o que TODO token já emitido pode fazer. Daí o
-- alcance: cada token serve a um uso, e os já emitidos continuam valendo só
-- para análise.
--
-- Enumeração em tabela + FK (ADR 0011), com a validade padrão de cada alcance
-- como dado: 30 dias para análise (como sempre foi), 365 para saúde — um
-- monitor que morre todo mês é um monitor desligado.
CREATE TABLE analytics_token_scopes (
    key      TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    ttl_days INTEGER NOT NULL
);

INSERT INTO analytics_token_scopes (key, name, ttl_days) VALUES
    ('analytics', 'Análise (benchmark)', 30),
    ('health',    'Saúde (monitoração)', 365);

ALTER TABLE analytics_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'analytics';
ALTER TABLE analytics_tokens ADD CONSTRAINT analytics_tokens_scope_fkey
    FOREIGN KEY (scope) REFERENCES analytics_token_scopes(key);

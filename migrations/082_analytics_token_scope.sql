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
-- Enumeração em tabela (ADR 0011), com a validade padrão de cada alcance como
-- dado: 30 dias para análise (como sempre foi), 365 para saúde — um monitor
-- que morre todo mês é um monitor desligado. A fonte permanente das linhas é
-- auth.js#seedTokenScopes no boot (TOKEN_SCOPE_DEFS); as linhas aqui são o
-- pré-requisito para a coluna nascer com DEFAULT válido em bancos que já têm
-- tokens, no fluxo de dev (migration roda ANTES do servidor).
--
-- A FK (analytics_tokens.scope → analytics_token_scopes.key) NÃO entra aqui,
-- de propósito: entra na migration seguinte, num Publish posterior. O Publish
-- leva schema e não dados — se a FK viesse junto, o diff tentaria criá-la em
-- produção com a tabela de alcances ainda vazia (as linhas só chegam no boot,
-- DEPOIS do diff) e tokens existentes já apontando para 'analytics', e a FK
-- falharia. É a explicação mais provável para a FK da 074 nunca ter chegado
-- a produção (#389): a mesma ordem, enumeração semeada no boot + FK no diff.
CREATE TABLE analytics_token_scopes (
    key      TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    ttl_days INTEGER NOT NULL
);

INSERT INTO analytics_token_scopes (key, name, ttl_days) VALUES
    ('analytics', 'Análise (benchmark)', 30),
    ('health',    'Saúde (monitoração)', 365);

ALTER TABLE analytics_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'analytics';

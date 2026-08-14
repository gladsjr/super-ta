-- Tokens de ativação de convite (issue #156): guardar só o HASH, nunca o token
-- cru. Antes o token ficava em texto puro em invites.token — quem lesse a tabela
-- conseguia ativar a conta de outra pessoa (a ativação redefine a senha). Agora
-- guarda-se apenas sha256(token); o token cru é conhecido SÓ no momento da
-- emissão (issueInvite o devolve uma vez, para montar o link ali). A validação
-- em /ativar passa a comparar o hash do token recebido.
--
-- sha256() é built-in do Postgres (>= 11), sem pgcrypto. Backfill hasheia os
-- tokens existentes, então os links pendentes já distribuídos seguem válidos.
ALTER TABLE invites ADD COLUMN token_hash TEXT;
UPDATE invites SET token_hash = encode(sha256(token::bytea), 'hex');
ALTER TABLE invites ALTER COLUMN token_hash SET NOT NULL;
CREATE UNIQUE INDEX invites_token_hash_idx ON invites (token_hash);
-- Remove a coluna do token cru (e, com ela, o índice invites_token_idx).
ALTER TABLE invites DROP COLUMN token;

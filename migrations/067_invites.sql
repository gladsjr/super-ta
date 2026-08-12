-- Convites de ativação de conta (spec do piloto, 04/08/2026). Uma pessoa criada
-- por um admin nasce SEM senha; o convite carrega um token de uso único que
-- deixa a pessoa escolher a senha (ativação). Estados DERIVADOS, sem coluna:
-- usado (used_at), cancelado (canceled_at), expirado (expires_at < now()),
-- senão pendente. Reenviar = cancelar os anteriores + criar um novo (o link
-- antigo morre).
--
-- v1 SEM servidor de e-mail (decisão de 04/08/2026): o sistema gera um TXT com
-- os e-mails que SERIAM enviados, para download; o envio é sempre uma ação
-- explícita do administrador. `email` é snapshot do destino no momento do
-- convite (o e-mail da pessoa pode mudar depois).
CREATE TABLE invites (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  token               TEXT UNIQUE NOT NULL,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  canceled_at         TIMESTAMPTZ
);

CREATE INDEX invites_user_idx  ON invites (user_id);
CREATE INDEX invites_token_idx ON invites (token);

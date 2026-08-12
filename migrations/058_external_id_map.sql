-- Habilitador da INTEGRAÇÃO GRADUAL (opcional). Registro canônico interno
-- (users/units) + mapeamento de id externo POR PROVEDOR. Cada pessoa/unidade
-- pode ter um id externo por provedor, sem que isso seja obrigatório.
--
-- Degraus (só 'google' e 'csv' são exercidos no v1; os demais são nomeados,
-- não exigidos): manual → csv → oneroster → lti → scim → ...
CREATE TABLE external_id_map (
  id           SERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user','unit')),
  subject_id   INTEGER NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject_type, external_id)
);

CREATE INDEX external_id_map_subject_idx ON external_id_map (subject_type, subject_id);

-- Ledger de SAQUE de entitlement. Uma linha por item efetivamente consumido no
-- início de uma execução (entrevista/prova oral). Auditoria + rastro do que cada
-- trabalho/submissão sacou e sob qual config travada.
--
-- ON DELETE RESTRICT no counter_id: não deixamos apagar um contador com histórico
-- de saque pendurado (integridade da contabilidade de uso).
CREATE TABLE entitlement_consumption (
  id                SERIAL PRIMARY KEY,
  counter_id        INTEGER NOT NULL REFERENCES entitlement_counters(id) ON DELETE RESTRICT,
  item_key          TEXT NOT NULL,
  work_id           INTEGER REFERENCES works(id) ON DELETE SET NULL,
  submission_id     INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  drawn_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locks_json        JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ent_consume_work_idx    ON entitlement_consumption (work_id);
CREATE INDEX ent_consume_sub_idx     ON entitlement_consumption (submission_id);
CREATE INDEX ent_consume_counter_idx ON entitlement_consumption (counter_id);

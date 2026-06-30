-- works.kind já existe (migration 021, prova oral) com CHECK (interview, oral_realtime).
-- Aqui só AMPLIA para aceitar também 'scenario' (multi-interação). RENOMEIA a
-- constraint (drop do nome antigo + add com nome novo) para o diff do Publish do
-- Replit propagar a nova definição — ver migration 029 (constraint comparada por nome).
ALTER TABLE works DROP CONSTRAINT works_kind_check;
ALTER TABLE works ADD CONSTRAINT works_kind_chk CHECK (kind IN ('interview', 'oral_realtime', 'scenario'));

-- Rótulos de unidade como TABELA-LOOKUP (padrão enum-por-tabela do projeto, igual
-- a `roles`) — decisão de 07/08/2026. Antes o rótulo era string livre em
-- `units.label`, o que causava redundância (a mesma unidade mostrava o rótulo
-- "turma" E o flag is_class) e inconsistência ("Curso" vs "curso").
--
-- 'turma' é o tipo ESPECIAL (id 1): dispara o comportamento de turma (recebe
-- trabalho, não tem filhos). is_class continua existindo, mas agora é DERIVADO
-- de label == turma (mantido no código; ver lib/units.js). O tipo de uma unidade
-- é "configurado de cima" (admin do pai), como o nome.
CREATE TABLE unit_labels (
  id   SERIAL PRIMARY KEY,
  key  TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

-- turma primeiro → id 1 (o "código 1" especial). O código identifica turma pela
-- KEY 'turma', não pelo número.
INSERT INTO unit_labels (key, name) VALUES
  ('turma',        'Turma'),
  ('instituicao',  'Instituição'),
  ('universidade', 'Universidade'),
  ('faculdade',    'Faculdade'),
  ('escola',       'Escola'),
  ('campus',       'Campus'),
  ('departamento', 'Departamento'),
  ('instituto',    'Instituto'),
  ('curso',        'Curso');

ALTER TABLE units ADD COLUMN label_id INTEGER REFERENCES unit_labels(id) ON DELETE SET NULL;

-- Backfill. Toda unidade is_class vira tipo 'turma' (resolve o caso das que hoje
-- estão marcadas "Curso" mas são turma). As demais mapeiam o rótulo livre por
-- nome (case-insensitive); sem correspondência fica NULL.
UPDATE units u SET label_id = (SELECT id FROM unit_labels WHERE key = 'turma')
  WHERE u.is_class = true;
UPDATE units u SET label_id = l.id
  FROM unit_labels l
  WHERE u.is_class = false AND u.label IS NOT NULL AND lower(l.name) = lower(u.label);

ALTER TABLE units DROP COLUMN label;
CREATE INDEX units_label_idx ON units (label_id);

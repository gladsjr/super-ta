-- Triagem do professor sobre os indícios de fiscalização (issue #246).
--
-- O professor revisa o vídeo, forma um juízo e hoje não tem onde registrá-lo: a
-- triagem se perde e o pipeline de avaliação/devolutiva não a leva em conta.
--
-- Enumeração em TABELA, não em CHECK de strings (ADR 0011): estes níveis podem
-- evoluir, e mudar a definição de um CHECK mantendo o nome NÃO propaga no Publish
-- do Replit. As linhas são sincronizadas por seed a partir de PROCTOR_REVIEW_DEFS
-- (lib/proctorReview.js), como já se faz com `roles`.
--
-- A referência é pela CHAVE textual estável (não pelo id serial): é ela que o
-- código usa, e id numérico cru espalhado pelo código mata a legibilidade — o que
-- a própria ADR 0011 aponta. O id serial fica para ordenação interna.
CREATE TABLE proctor_review_levels (
    id         SERIAL PRIMARY KEY,
    key        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    ordem      INTEGER NOT NULL DEFAULT 0,
    confirmado BOOLEAN NOT NULL DEFAULT false
);

-- Semente mínima para a coluna abaixo poder referenciar já no default. O seed do
-- boot reconcilia nome/ordem/confirmado e remove o que sair da constante.
INSERT INTO proctor_review_levels (key, name, ordem, confirmado) VALUES
    ('nao_revisado',        'Não revisado',           0, false),
    ('sem_problema',        'Sem problema',           1, false),
    ('em_aberto',           'Em aberto',              2, false),
    ('confirmado_leve',     'Confirmado — leve',      3, true),
    ('confirmado_moderado', 'Confirmado — moderado',  4, true),
    ('confirmado_grave',    'Confirmado — grave',     5, true);

-- Veredito por submissão. Default 'nao_revisado' (DISTINTO de 'em_aberto': sem
-- essa diferença não dá para saber o que falta revisar, que é a fila de trabalho
-- do professor).
ALTER TABLE submissions
    ADD COLUMN proctor_review TEXT NOT NULL DEFAULT 'nao_revisado'
        REFERENCES proctor_review_levels(key),
    ADD COLUMN proctor_review_note TEXT,
    ADD COLUMN proctor_reviewed_at TIMESTAMPTZ;

CREATE INDEX submissions_proctor_review_idx ON submissions (work_id, proctor_review);

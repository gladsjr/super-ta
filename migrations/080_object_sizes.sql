-- #349: servir vídeo com HTTP Range exige o tamanho total do objeto para montar
-- o Content-Range. O StorageObject da SDK do Replit só expõe `name`, e descobrir
-- o tamanho baixando o arquivo é exatamente o que estamos eliminando.
--
-- Tabela por CHAVE (não coluna em submissions) porque nem todo objeto servido
-- pertence a uma lista de partes: o vídeo CONSOLIDADO da prova oral tem chave
-- própria, é o que o player usa, e é justamente onde o seek mais importa.
-- Serve também para qualquer mídia futura.
--
-- Objetos anteriores a esta migration ficam de fora: a rota serve 200 inteiro
-- (sem Range) nesse caso — degrada o seek, mas nunca carrega o arquivo na memória.
CREATE TABLE object_sizes (
    object_key TEXT PRIMARY KEY,
    bytes      BIGINT NOT NULL CHECK (bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

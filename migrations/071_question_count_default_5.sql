-- Baixa o default de works.question_count de 6 para 5 (decisão de produto:
-- 5 perguntas por padrão em TODOS os tipos de interação — entrevista por
-- mensagem, entrevista em tempo real e prova oral). createWork não passa
-- question_count, então trabalhos novos herdam este default da coluna.
-- Trabalhos existentes não mudam (só o default de novas linhas).
ALTER TABLE works ALTER COLUMN question_count SET DEFAULT 5;

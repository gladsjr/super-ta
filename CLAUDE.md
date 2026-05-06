#Contexto arquitetural e features
Leia o @replit.md para uma visão geral arquitetural e das features do sistema

Diretriz permanente:
- evite fallback arquitetural e hierarquia de opções de configuração quando isso obscurecer o comportamento do sistema;
- para seleção de modelo, use apenas `config/policy.yaml` como fonte de verdade;
- se uma configuração obrigatória estiver ausente, prefira falhar explicitamente.

Convenções de prompt para agentes:
- YAMLs de configuração (hoje o `interviewer.yaml`; no futuro outros) nunca vão ao LLM crus. Sempre rodam por um template que explica o significado de cada campo. Veja `config/interviewer_agenda_template.txt` + `lib/interviewerAgenda.js`.
- Qualquer agente novo que precise da agenda do entrevistador usa `renderInterviewerAgenda(yamlText)`. Não recrie a estrutura.
- Contexto de conversa curto e bem-delimitado (ex.: turno corrente + intervenções) vem do estado local em `SESSIONS` (`sess.turnLog`), não da Conversations API. O parâmetro `conversation:` das Responses polui o `conv_chat` remoto com turnos internos; evite.

Schema do banco — diretriz permanente:
- O schema vive em um único arquivo idempotente: `schema.sql`. Ele é reaplicado a cada boot do servidor por `applySchema()` em `auth.js` (chamada em `server.js`, antes dos seeds). Isso converge o banco em dev local, Replit e qualquer prod sem aplicação manual de patches.
- Operações permitidas em `schema.sql` (idempotentes por construção):
  - `CREATE TABLE IF NOT EXISTS ...`
  - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
  - `CREATE INDEX IF NOT EXISTS ...`
- Convenção ao adicionar uma coluna nova: atualize **ambos** — a definição dentro do bloco `CREATE TABLE IF NOT EXISTS` (para setups greenfield) E adicione um `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` logo abaixo (para bancos já existentes).

GATILHO PARA TROCAR PARA MIGRATIONS — Claude deve detectar e avisar o usuário:
Se uma mudança de schema exigir QUALQUER uma das operações abaixo, **pare de adicionar ao `schema.sql`** e proponha explicitamente ao usuário a migração para a abordagem de migrations (descrita no fim desta seção). Não tente espremer essas operações no schema idempotente — elas vão rodar a cada boot e causar dano.
- `DROP COLUMN` ou `DROP TABLE`
- `ALTER COLUMN ... TYPE ...` (mudança de tipo)
- `RENAME COLUMN` ou `RENAME TABLE`
- `ALTER COLUMN ... SET NOT NULL` em coluna que pode ter linhas com NULL
- Adição de constraint que pode falhar em dados existentes (`UNIQUE`, `CHECK`, `FOREIGN KEY`)
- Data migration: qualquer `UPDATE`/`INSERT` que dependa de estado pré-existente para backfill ou correção
- Reordenação de operações que afete semântica entre versões

Abordagem de migrations (a aplicar quando o gatilho disparar):
1. Criar `migrations/` com arquivos numerados: `001_init.sql`, `002_descricao.sql`, ... — em ordem de aplicação.
2. Criar tabela `schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())` na própria primeira migration.
3. Substituir `applySchema()` por `runMigrations()`: lista versões aplicadas, roda cada arquivo pendente em ordem dentro de uma transação (uma migration = uma transação), registra na tabela ao final de cada uma.
4. `001_init.sql` é o snapshot atual de `schema.sql`. Migrations seguintes são deltas (DROP, ALTER TYPE, etc.).
5. `schema.sql` deixa de ser executado no boot — pode ser mantido apenas como referência documental do estado final desejado, ou removido.
6. A troca é não-trivial: faça em PR isolado, com plano detalhado antes de mudar código.

Mapa de prompts — regra permanente:
- Todo prompt enviado à LLM deve ser alcançável a partir do diagrama em `docs/architecture.md`. Sem exceção.
- Quando criar/mover/renomear um prompt (seja `systemPrompt` em agente, template `.txt` em `config/` ou string inline em `server.js`), atualize na mesma mudança:
  (a) o `click` do nó correspondente no diagrama Mermaid de `docs/architecture.md`,
  (b) a coluna "Prompt enviado à LLM" da tabela de navegação do mesmo arquivo, e
  (c) o "Índice completo de prompts" na mesma página.
- Ao adicionar um agente novo: incluir o nó no diagrama com `click` apontando para a linha do `systemPrompt` (não para o topo do arquivo), e listar o agente no índice.
- Strings inline de prompt em `server.js` são toleradas, mas devem aparecer no índice com link `arquivo#Llinha`. Se virarem mais que duas-três linhas, prefira extrair para arquivo dedicado em `config/` e linkar o `.txt`.
- O diagrama é o ponto único de descoberta. Não criar índices paralelos em outros docs.

#
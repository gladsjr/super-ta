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

Migrations file-per-change. Toda mudança de schema vai num arquivo novo em `migrations/`, nunca em arquivo já aplicado.

Mecânica:
- Arquivos: `migrations/NNN_descricao.sql`, NNN com zero-padding em 3 dígitos (`001`, `002`, ..., `999`). Aplicados em ordem alfabética = ordem numérica.
- Runner: `lib/migrations.js#runMigrations()`, chamado no boot do servidor antes dos seeds. Cada arquivo roda em sua própria transação. Falha em qualquer migration = rollback dela + boot abortado.
- Tabela de controle: `schema_migrations(version, filename, applied_at)`. Criada automaticamente. Cada migration aplicada com sucesso é registrada com sua versão.
- CLI: `npm run db:migrate` aplica pendentes; `npm run db:migrate -- status` lista status sem aplicar.
- O servidor também aplica no boot — em dev e Replit, geralmente não se usa o CLI.

Workflow para qualquer mudança de schema (aditiva ou destrutiva):
1. Olhar último número em `migrations/`. Criar `migrations/NNN+1_descricao.sql`.
2. Escrever SQL direto, SEM `IF NOT EXISTS` ou guards de idempotência — cada migration roda exatamente uma vez por banco.
3. Reiniciar server local → runner aplica → testar.
4. Commit + push. Em qualquer ambiente (Replit, prod), o boot reaplicará as pendentes.

Regras duras (Claude deve respeitar e avisar o usuário se ele propor o contrário):
- **Nunca editar uma migration depois de qualquer deploy.** Mesmo um typo em comentário. A tabela `schema_migrations` confia em "filename já aplicado"; editar quebra reproducibilidade entre ambientes.
- **Para corrigir bug em migration JÁ aplicada**: criar uma migration corretiva (NNN+1). Nunca editar a anterior.
- **Para corrigir bug em migration que falhou (rollback, não registrada)**: editar é OK — não foi aplicada em lugar nenhum ainda.
- **Migration falha em prod = bug bloqueante.** Tabela `schema_migrations` não recebe a versão, o boot vai tentar e falhar a cada reinício até alguém investigar e subir uma correção. Tratar como incidente.
- **Seeds são separados de migrations.** `seedInitialUsers()` e `seedInterviewerTemplates()` continuam em `auth.js` e rodam DEPOIS das migrations. Migrations cuidam de schema; seeds cuidam de dados de bootstrap. Não misturar.
- **`001_init.sql` é o snapshot bootstrap** — escrito com `IF NOT EXISTS` em tudo, justamente porque pode rodar contra um banco legado que veio do antigo `schema.sql`. Migrations a partir da 002 são deltas puros.

Operações que migrations habilitam (que o esquema antigo não suportava):
- `DROP COLUMN`, `DROP TABLE`
- `ALTER COLUMN ... TYPE ...`
- `RENAME COLUMN`, `RENAME TABLE`
- `ALTER COLUMN ... SET NOT NULL` (após backfill)
- Adição de constraint com possível conflito em dados existentes (`UNIQUE`, `CHECK`, `FOREIGN KEY`)
- Data migrations (`UPDATE`/`INSERT` para backfill ou correção)

Limites:
- Migrations zero-padded em 3 dígitos cobrem 999 mudanças. Se chegar perto, expandir para 4 dígitos via migration corretiva (renomear arquivos antigos exige cuidado — ver "nunca editar"). Improvável precisar.
- O runner é serial e simples — não suporta migrations em paralelo nem rollback automático de uma migration aplicada com sucesso (se precisar reverter, criar a migration inversa).

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
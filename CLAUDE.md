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

Modo de interação (texto vs áudio) — diretriz permanente:
- Análise é sempre em texto. Áudio existe apenas como última-milha da interface com o aluno (STT na entrada, TTS na saída). Agentes, evaluators, document map, vector store, log da conversa e relatório final operam só em texto. Nunca passar áudio para um agente.
- Áudio não é persistido. TTS vai num cache LRU em memória de sessão (`sess.audioCache`, `lib/audio.js#AudioCache`) e é servido por `GET /s/:t/audio/:turnId`. Se o cache evict ou o servidor reiniciar, o frontend degrada para texto.
- Modo de interação é re-sincronizado com a configuração atual do trabalho em **dois momentos**: (1) quando uma sessão nova é criada em `/s/:t/start`, e (2) a cada `/s/:t/upload` (cada upload é uma nova tentativa de entrevista — reset do turnLog, etc.). Entre esses dois pontos, o modo fica imutável durante a entrevista em andamento. Mudanças no painel do professor afetam: novos alunos abrindo o link, alunos que ainda não enviaram PDF, ou alunos que reenviarem o PDF.
- Modelos STT e TTS vivem em `config/policy.yaml` (`stt_model`, `tts_model`). Fail-fast no boot se ausentes, igual aos outros.
- Vozes ficam em `config/voices.js`. Adicionar uma voz nova = editar o array. Validação via `isValidVoice()` em qualquer ponto que aceite voiceId.

Schema do banco — diretriz permanente:

Migrations file-per-change. Toda mudança de schema vai num arquivo novo em `migrations/`, nunca em arquivo já aplicado.

Mecânica:
- Arquivos: `migrations/NNN_descricao.sql`, NNN com zero-padding em 3 dígitos (`001`, `002`, ..., `999`). Aplicados em ordem alfabética = ordem numérica.
- Runner: `lib/migrations.js#runMigrations()`, invocado pelo CLI `scripts/migrate.mjs` — NÃO mais no boot do servidor. Cada arquivo roda em sua própria transação. Falha em qualquer migration = rollback dela + o CLI sai com código 1.
- Tabela de controle: `schema_migrations(version, filename, applied_at)`. Criada automaticamente. Cada migration aplicada com sucesso é registrada com sua versão.
- CLI: `npm run db:migrate` aplica pendentes; `npm run db:migrate -- status` lista status sem aplicar.
- Onde rodam (só em dev): no Replit o comando do workflow é `npm run db:migrate && node server.js`; localmente o `predev` roda `db:up && db:migrate`. O `server.js` NÃO roda migrations.
- Produção: o boot não toca no schema. O fluxo de **Publish** do Replit faz o diff dev→prod e aplica em prod. As migrations seguem sendo a fonte versionada do schema (histórico em git) e o jeito de evoluir o dev.

Por que migrations NÃO rodam no boot (decisão, não acidente — não reverta sem ler):
- Antes, `server.js` rodava `runMigrations()` no boot. O **Publish** do Replit, porém, aplica o diff de schema dev→prod **sem** registrar nada na `schema_migrations` do prod. Resultado: o boot do prod tentava reaplicar uma migration que o Publish já tinha materializado e quebrava (ex.: `column already exists`), travando o boot a cada reinício até alguém corrigir o ledger na mão.
- Correção estrutural: o boot nunca roda DDL. Dev evolui via `npm run db:migrate`; prod é materializado pelo Publish. A `schema_migrations` é o ledger do **dev**; em prod ela existe mas ninguém a lê no boot.
- Consequência operacional: uma migration precisa estar aplicada/testada no dev **antes** do Publish, senão o diff não a leva pro prod.

Workflow para qualquer mudança de schema (aditiva ou destrutiva):
1. Olhar último número em `migrations/`. Criar `migrations/NNN+1_descricao.sql`.
2. Escrever SQL direto, SEM `IF NOT EXISTS` ou guards de idempotência — cada migration roda exatamente uma vez por banco.
3. Aplicar no dev: `npm run db:migrate` (ou reiniciar o workflow do Replit, que migra antes de subir) → testar.
4. Commit + push. Para levar a prod: **Publish** no Replit (diff dev→prod). O boot do prod NÃO reaplica migrations.

Regras duras (Claude deve respeitar e avisar o usuário se ele propor o contrário):
- **Nunca editar uma migration depois de qualquer deploy.** Mesmo um typo em comentário. A tabela `schema_migrations` confia em "filename já aplicado"; editar quebra reproducibilidade entre ambientes.
- **Para corrigir bug em migration JÁ aplicada**: criar uma migration corretiva (NNN+1). Nunca editar a anterior.
- **Para corrigir bug em migration que falhou (rollback, não registrada)**: editar é OK — não foi aplicada em lugar nenhum ainda.
- **Migrations só rodam em dev.** Em prod, quem aplica schema é o Publish do Replit (o boot não roda DDL). Logo, uma migration precisa estar aplicada e testada no dev ANTES do Publish, pra que o diff a leve pro prod. Migration que falha no dev = bug bloqueante: corrigir antes de publicar.
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
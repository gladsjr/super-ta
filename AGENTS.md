# AGENTS.md — convenções do super-ta (ORATIA)

**Este é o arquivo canônico de convenções para qualquer agente que mexa neste
repositório** — Claude Code, Codex, Cursor, Copilot ou humano. `CLAUDE.md` aponta
para cá e só acrescenta o que é específico do Claude Code. Não duplique regra
aqui em outro arquivo: se precisar mudar uma convenção, mude **neste** arquivo.

Panorama do sistema: [`replit.md`](replit.md).
O que o produto faz: [`docs/capacidades/`](docs/capacidades/README.md).
Por que as escolhas são estas: [`docs/decisoes/`](docs/decisoes/README.md).

## Divisão de ambientes — regra dura

Três agentes mexem neste projeto. Cada um trabalha no SEU clone, com o SEU banco
e a SUA porta. **Nenhum agente toca no ambiente do outro** — não troca a branch
do outro, não recria nem migra o banco do outro, não sobe servidor na porta do
outro.

| Agente | Working tree | Banco (no container `superta-db`) | Porta | Branch |
|---|---|---|---|---|
| Claude | `…/ORATIA/super-ta-repo` | `oratia_claude` | `:5000` | a feature em andamento |
| Codex | `…/ORATIA/super-ta-codex` | `oratia_codex` | `:5001` | `feat/multiagent-scenarios-mock` |
| Replit | ambiente próprio (Reserved VM) | banco próprio (dev/prod) | — | `main` |

- O container Postgres é compartilhado, mas cada agente usa **só o seu database**.
- **Working tree vivo do usuário** (`C:\Users\glads\src\super-ta`): ninguém toca.
- **`main` é a fonte única** que vai a produção. Cada agente dá push só na sua
  branch; integração via PR.
- Bancos legados (`superta`, `superta_oral`, `superta_codex`, `superta_claude*`)
  são lixo de migração antiga — ignorar até o usuário autorizar limpeza.
- **Se houver mais de uma sessão no mesmo clone**, não troque de branch: uma
  working tree só tem um checkout, e trocar puxa os arquivos debaixo da outra
  sessão. Use `git worktree add` para trabalho paralelo.

## Decisões travadas — não reverta sem ler a ADR

Cada linha abaixo **parece um bug ou um descuido e não é**. Todas foram tomadas
depois de um problema real; várias já custaram produção. Se uma tarefa levar você
a mexer numa delas, **abra a ADR primeiro** — o arquivo tem o contexto, a
alternativa descartada e o custo aceito.

| # | O que está travado |
|---|---|
| [0001](docs/decisoes/0001-migrations-nao-rodam-no-boot.md) | O boot **não** roda DDL. Migrations só em dev; produção é materializada pelo Publish. |
| [0002](docs/decisoes/0002-falhar-explicito-sem-fallback.md) | Configuração obrigatória ausente **derruba o boot**. Nada de padrão silencioso, inclusive preço de modelo. |
| [0003](docs/decisoes/0003-analise-sempre-em-texto.md) | **Nunca** passe áudio a um agente. Áudio é só última milha com o aluno. |
| [0004](docs/decisoes/0004-proctoring-nao-acusa-automaticamente.md) | Fiscalização **não** penaliza nota nem acusa automaticamente. A penalidade automática foi removida de propósito. |
| [0005](docs/decisoes/0005-video-obrigatorio-e-bloqueante.md) | Com fiscalização ligada, vídeo é **bloqueante** nos três fluxos. Falhar em aberto foi o bug anterior. |
| [0006](docs/decisoes/0006-um-raciocinio-por-turno.md) | Guardas (teto de turnos, encerramento, validação) ficam **no código**, nunca no prompt. |
| [0007](docs/decisoes/0007-gabarito-nunca-sai-do-servidor.md) | O gabarito da prova oral **não** chega ao navegador nem à sessão de voz. |
| [0008](docs/decisoes/0008-voz-realtime-nao-e-mais-barata.md) | Voz em tempo real **não** é mais barata que mensagens. Hipótese medida e refutada. |
| [0009](docs/decisoes/0009-nota-e-devolutiva-publicam-separado.md) | **Na entrevista**, nota e devolutiva têm publicações **independentes** (na prova oral, ver 0012). Nenhuma sai sem ação do professor. |
| [0010](docs/decisoes/0010-config-nao-vai-crua-ao-modelo.md) | Configuração estruturada **nunca** vai crua ao modelo: passa por template. |
| [0011](docs/decisoes/0011-enumeracoes-em-tabela.md) | Enumeração que evolui vai em **tabela + FK**, não em `CHECK` de strings. |
| [0012](docs/decisoes/0012-publicacao-conjunta-na-prova-oral.md) | **Na prova oral**, nota e devolutiva publicam **juntas** (um só controle). Supersede a 0009 nesse escopo. |
| [0013](docs/decisoes/0013-resultados-de-benchmark-sao-portaveis.md) | Resultado de benchmark só é comparável **dentro do mesmo par setup + júri**. O formato do pacote portátil é contrato. |
| [0014](docs/decisoes/0014-analytics-consulta-tabelas-base.md) | **Não construa nada que dependa de view, function ou schema alternativo** — o Publish não os propaga. Funciona em dev e falha em produção. |
| [0015](docs/decisoes/0015-devolutiva-uniforme-na-turma.md) | `per_question` da devolutiva **não é escolha do modelo**: cobertura completa é obrigatória quando o relatório interno tem entradas. |
| [0016](docs/decisoes/0016-turno-e-pergunta-do-plano.md) | Na entrevista em tempo real, **turno = pergunta do plano**; o resto da conversa é intervenção do turno. |
| [0017](docs/decisoes/0017-triagem-humana-da-fiscalizacao.md) | A triagem da fiscalização é **humana**. `sem problema` SUPRIME o alerta na devolutiva; `não revisado` e `em aberto` não entram. A nota nunca muda sozinha. |
| [0018](docs/decisoes/0018-limiar-destaca-nao-oculta.md) | O limiar **destaca, não oculta**: todo eixo analisado aparece. Limiares em fonte única (`static/js/proctorAxes.js`); celular em SEGUNDOS. |
| [0019](docs/decisoes/0019-lote-avalia-quem-concluiu.md) | Lote só pega quem **concluiu e não é teste**; `force` não fura a regra. Teste, em andamento e desistência: só individualmente. |
| [0020](docs/decisoes/0020-queda-de-gravacao-pausa-na-primeira.md) | Queda de gravação pausa na **primeira**; retomada exige **liberação do professor** (consumida a cada uso). Retomada automática era falhar em aberto. |
| [0021](docs/decisoes/0021-vigilancia-fala-pela-interface.md) | Vigilância de posição ao vivo fala pela **interface** (pausa + modal), nunca pela voz; sob carga a detecção **morre primeiro**, a gravação nunca; desligada vira sinal. |

Decisão nova **supersede** a antiga (ADR nova, estado da antiga vira "Superada
por NNNN"); nunca reescreva uma ADR aceita.

## Invariantes de privacidade — não negociáveis

- O **gabarito** da prova oral nunca chega ao navegador nem à sessão de voz. Só
  as perguntas saem do servidor. → [ADR 0007](docs/decisoes/0007-gabarito-nunca-sai-do-servidor.md)
- O **vídeo** da fiscalização nunca vai para a OpenAI. A análise é local.
- **Consentimento** (câmera e gravação) é obrigatório antes da arguição.
- Fiscalização **nunca** vira acusação nem penalidade automática.
  → [ADR 0004](docs/decisoes/0004-proctoring-nao-acusa-automaticamente.md)

## Convenções de prompt

- **Configuração estruturada nunca vai crua ao modelo**: passa por um template
  que explica cada campo (`config/interviewer_agenda_template.txt` +
  `lib/interviewerAgenda.js`). Quem precisa da agenda do arguidor usa
  `renderInterviewerAgenda(yamlText)` — não recrie a estrutura.
  → [ADR 0010](docs/decisoes/0010-config-nao-vai-crua-ao-modelo.md)
- Contexto curto e delimitado (turno corrente, intervenções) vem do estado local
  em `SESSIONS` (`sess.turnLog`), **não** da Conversations API — o parâmetro
  `conversation:` polui o `conv_chat` remoto com turnos internos.

## Helpers compartilhados

- **Saída estruturada** (`json_schema`, não-streaming): use
  `lib/agentRun.js#runStructured`. Ele concentra montar o payload, registrar o
  prompt, medir custo, extrair e validar o JSON, e repetir em caso de falha.
  Passe só o que varia. Exceções legítimas: `SuperOrchestratorAgent` (streaming),
  `StudentFeedbackAgent` (muta o payload no retry) e `EnunciadoCoherenceAgent`
  (saída livre).
- **Lote com concorrência limitada**: use `lib/concurrency.js#mapPool`. Não
  escreva pool de workers à mão.
- **STT (fala do aluno → texto)**: use `lib/stt.js#sttTranscribe` — a camada de
  provedor (#284) cuida de fallback, metering e sombra. Não chame
  `audio.transcriptions.create` nem `transcribeAudio` direto em rota nova.

## Migrations — file-per-change

Toda mudança de schema vai num arquivo novo em `migrations/`, nunca num já
aplicado. **O boot não roda DDL** — entenda o porquê antes de mexer:
→ [ADR 0001](docs/decisoes/0001-migrations-nao-rodam-no-boot.md)

Mecânica: arquivos `migrations/NNN_descricao.sql` (3 dígitos, ordem alfabética =
numérica); cada um roda em sua própria transação; `npm run db:migrate` aplica
pendentes e `npm run db:migrate -- status` lista sem aplicar. Em dev o `predev`
migra antes de subir; em produção quem materializa é o **Publish** do Replit
(diff dev→prod).

Fluxo: veja o último número → crie `NNN+1` → escreva SQL direto, **sem**
`IF NOT EXISTS` ou guardas de idempotência → aplique em dev → teste → commit.

**Regras duras** (avise o usuário se ele propuser o contrário):

- **Nunca edite uma migration depois de qualquer deploy**, nem um typo em
  comentário. Para corrigir, crie uma corretiva `NNN+1`.
- Editar migration que **falhou** (rollback, não registrada) é OK — não foi
  aplicada em lugar nenhum.
- Migration precisa estar aplicada e testada em **dev antes do Publish**, senão o
  diff não a leva para produção.
- **Seeds são separados de migrations** e rodam depois delas (`auth.js`).
  Migrations cuidam de schema; seeds, de dados de bootstrap.
- **Enumerações que evoluem vão em tabela + FK**, não em `CHECK` de strings.
  → [ADR 0011](docs/decisoes/0011-enumeracoes-em-tabela.md)
- **Colisão de números entre branches:** se a `main` já tem `NNN`, renumere a sua.
- `001_init.sql` é o snapshot de bootstrap (escrito com `IF NOT EXISTS` de
  propósito). Da `002` em diante são deltas puros.

Limites conhecidos: o runner é serial, sem paralelismo e sem rollback automático
de migration bem-sucedida (para reverter, crie a inversa).

> Estas regras também são injetadas automaticamente por um hook sempre que um
> agente vai escrever em `migrations/` (`.claude/hooks/migrations-guard.mjs`).
> Ele avisa, não bloqueia. Para mudar o texto, edite `migrations-guard.md` ao
> lado — não o script.

## Mapa de prompts — regra permanente

Todo prompt enviado à LLM deve ser alcançável a partir do diagrama em
[`docs/architecture.md`](docs/architecture.md). Sem exceção.

Ao criar, mover ou renomear um prompt, atualize **na mesma mudança**: (a) o
`click` do nó no diagrama, (b) a coluna "Prompt enviado à LLM" da tabela de
navegação, e (c) o índice completo de prompts. Agente novo entra no diagrama com
`click` apontando para a linha do `systemPrompt`, não para o topo do arquivo.
O diagrama é o ponto único de descoberta — não crie índices paralelos.

## Documentação — o que atualizar junto com o código

| Se você mudou… | Atualize |
|---|---|
| o comportamento que o professor ou o aluno percebe | a página em [`docs/capacidades/`](docs/capacidades/README.md) |
| como um subsistema funciona por dentro | o arquivo de referência em `docs/` |
| um prompt ou um agente | o mapa em `docs/architecture.md` (as três partes) |
| uma escolha com consequência duradoura | uma ADR nova em [`docs/decisoes/`](docs/decisoes/README.md) |
| a lista de documentos importantes | [`llms.txt`](llms.txt) |

ADR aceita é **imutável**: decisão nova supersede a antiga, não a reescreve.
Plano de trabalho em aberto não é documentação — vive em issue e na descrição do
PR. Artefato de execução (transcrição, saída de bench, relatório gerado) também
não: vive em `tests/`, `bench/`, `reports/`.

## Idioma

Responda ao usuário em português brasileiro. Evite verbos aportuguesados de
termos em inglês ("deployar", "buildar", "commitar", "mergear"). Termos técnicos
consagrados (commit, deploy, branch, pipeline) podem ficar em inglês.
Documentação funcional e ADRs em português; referência técnica pode seguir em
inglês por herança.

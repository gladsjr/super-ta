# Verificação de saúde

> **Estado:** em construção · nível `shallow` em produção desde 2026-09-07
> Usuário desta capacidade: **a equipe que opera o sistema**, e a ferramenta de
> monitoração que ela configurar.

**Uma frase:** um endpoint e, em corte seguinte, uma tela de Operações que
perguntam ao sistema "o que está de pé?" — depois de cada publicação e de minuto
em minuto — para que a resposta não venha do aluno.

## Para que serve

Antes disto não havia nada: nenhum endpoint de saúde, nenhuma sonda, nenhuma
página. Depois de um Publish, o jeito de descobrir que uma migration não foi, que
um modelo de visão não subiu ou que a fila parou era esperar alguém tropeçar —
quase sempre tarde, e quase sempre um aluno no meio de uma arguição.

Esta capacidade troca isso por uma pergunta que a operação faz sozinha, com
resposta legível por gente e por robô.

## Como funciona

Cada **componente** é um *check* com quatro estados possíveis, não dois:

| Estado | Significa |
|---|---|
| `ok` | medido, e está bem |
| `warn` | medido, funciona, mas algo pede atenção ("responde em 4 s") |
| `fail` | medido, e não está de pé |
| `skip` | **não se aplica** a este ambiente — nunca se diz `ok` sobre o que não foi medido |

Os checks se organizam em três **profundidades**, por custo e por efeito
colateral:

- **`shallow`** — sem custo, sem efeito e sem processo filho: configuração
  ativa, banco (latência e pool), schema materializado, seeds e admin de
  bootstrap, filas de vídeo e retranscrição (com o batimento do executor),
  modelos e arquivos de mídia, versão do termo de consentimento. Alvo: menos
  de um segundo local, ~2 s em produção (banco remoto). É o nível da
  monitoração externa. **É o que existe hoje.**
- **`deep`** — uma ida real a cada dependência externa, pela **mesma porta
  que o produto usa**: storage (put, tamanho, leitura por faixa, apagar, numa
  chave própria), o modelo principal com o effort configurado, transcrição de
  um clip do sound check **com o texto conferido** (WER), síntese de voz, o
  módulo nativo de fiscalização (uma inferência real), o sidecar Python
  (MediaPipe), a retranscrição local (só se configurada; senão `skip`), o
  `ffmpeg`, e a **perna A do Realtime**: abre a sessão e manda o mesmo
  `session.update` do relay **com a voz de cada trabalho de voz ativo**,
  esperando a confirmação — é o acidente do #351, pego antes do aluno. Inclui
  o `shallow`. Cerca de US$ 0,002 e 10 s. Roda depois do Publish, pela tela
  ou por um token de saúde; **limitado a 12 por hora**, porque gasta. **É o
  que existe hoje.**
- **`e2e`** — o relay de voz completo, em produção, sobre um trabalho de saúde
  permanente. Só sob pedido explícito. *(corte seguinte; responde 501)*

Dois endpoints e uma tela:

- `GET /healthz` — liveness puro, sem autenticação e sem banco. Responde antes
  do store de sessão; é o que um robô de uptime chama. Por ser aberto, não conta
  nada além de "estou vivo": nem commit, nem versão (isso fica no relatório).
- `GET /admin/health?checks=db,jobs&depth=shallow` — o relatório. Aceita a
  **sessão de administrador** (tela) ou um **token de saúde** (monitoração). O
  corpo vem sempre completo; o **status HTTP reflete o pior resultado**: 200
  sem falhas, 503 com alguma.
- **Tela "Saúde do sistema"**, no topo da aba Operações do painel de
  administração: o mesmo relatório, com uma frase por verificação e o detalhe
  completo atrás de um botão. Carrega ao **entrar** na aba (nível `shallow`) e
  no botão "Verificar agora" — nunca no temporizador da fila, porque cada
  relatório são várias consultas em série. Um seletor escolhe a profundidade;
  o `deep` mostra o **custo estimado antes** e o custo real depois. Depois de
  um Publish, é a primeira coisa a olhar.

**Tokens têm alcance.** O token de acesso programático (aba Tokens do admin)
serve a **um** uso: `análise`, para o endpoint de consulta de dados, com 30
dias de validade; ou `saúde`, para este relatório, com 365 dias — um monitor
que morre todo mês é um monitor desligado. Um não serve ao outro (403). Motivo:
o token de análise é somente-leitura por construção, e o nível `deep` vai
escrever e gastar; reaproveitar o mesmo token ampliaria em silêncio o que todo
token já emitido pode fazer. Os tokens emitidos antes do alcance existir são
de análise.

## O que cada check de `deep` pega

| Check | O que descobre |
|---|---|
| Storage | a SDK do Replit mudou e o tamanho ou a leitura por faixa pararam — hoje isso aparece no professor tentando assistir a um vídeo (#376) |
| Modelo principal | chave, existência do modelo, aceitação do effort, latência |
| Transcrição | **degradação de qualidade**, não só disponibilidade: o texto de um clip conhecido saiu errado |
| Síntese de voz | modelo ou voz default recusados; bytes que não são áudio |
| Módulo nativo | `onnxruntime-node` não carrega nesta arquitetura ou imagem — hoje só se descobre na primeira análise de vídeo pós-prova |
| Sidecar Python | MediaPipe ausente — hoje o sidecar de mãos falha em silêncio |
| Retranscrição local | `faster-whisper` ausente, quando o motor local está configurado; senão `skip` |
| `ffmpeg` | binário ausente ou lento (em produção respondeu em 5,8 s) |
| Realtime, perna A | a OpenAI **recusa o `session.update`** com a voz de algum trabalho ativo — a prova rodaria em inglês, sem as questões (#351) |

## O que cada check de `shallow` pega

| Check | O que descobre, que hoje ninguém descobre a tempo |
|---|---|
| Configuração ativa | qual `policy.yaml` produção está de fato rodando |
| Schema materializado | o **mais valioso pós-Publish**: tabela, coluna, índice ou constraint que alguma migration cria e que **não existe no banco** — com a migration de origem. Confere o catálogo, não o ledger (ver abaixo) |
| Seeds | o schema foi, mas os dados de bootstrap não (enumerações vazias, alcances do token ausentes ou parciais); ou não há admin global |
| Filas | executor parou (sem tique, lease vencida), falhas nas últimas 24 h, job pendente há mais de uma hora |
| Modelos e arquivos de mídia | deploy sem os ONNX, sem o WASM, sem os mp3 do sound check (binários, como o `ffmpeg`, são do nível `deep`) |
| Consentimento | quantos alunos vão reaceitar o termo depois de uma mudança de versão |

## Por que o check de schema não lê o ledger

Em produção, `schema_migrations` **não diz a verdade**: o Publish do Replit
materializa o schema por diff dev→prod e não escreve uma linha no ledger
([ADR 0001](../decisoes/0001-migrations-nao-rodam-no-boot.md)). Medido em
07/09/2026: produção tinha 8 linhas no ledger e as 80 migrations no banco. Um
check que comparasse arquivos com o ledger acusaria 72 "pendentes" para sempre,
e uma monitoração que grita para sempre é uma monitoração desligada.

O que se confere é o **catálogo**, e só **daqui para frente**: as migrations
são lidas em ordem e dizem o que o schema deveria ter — tabelas, colunas,
índices e constraints, com os DROPs e RENAMEs aplicados —, mas o check só
espera o que as migrations **posteriores à linha de base (080)** criaram. O
histórico até ali foi validado uma vez, contra dev e contra produção
(07/09/2026), e a única divergência virou a migration 081; daí em diante o
passado é estado conhecido, e cada Publish novo é verificado sem reprocessar
os anteriores.

Isso só funciona com uma convenção, verificada por teste: **toda constraint e
todo índice em migration nova têm nome explícito** (`AGENTS.md`). O parser não
emula a nomenclatura automática do Postgres — objeto sem nome não é conferido,
e o teste da convenção acusa antes do PR. Em dev, onde o ledger é a verdade,
ele aparece como informação. O invariante que segura o parser é outro teste: o
banco de dev, migrado por definição, dá zero ausências no replay completo.
Detalhe em `lib/schemaExpectations.js`.

Cada ausência acusada vem com o que o catálogo **tem** naquela tabela, do mesmo
tipo — é o que distingue "falta" de "existe com outro nome", que foi a dúvida
da primeira medição em produção (#389).

## O que a primeira medição em produção ensinou (07/09/2026)

- O deployment do Replit não leva o `.git`: o commit saía `null`. O passo de
  `build` em `.replit` grava `.build-commit`, que o relatório lê.
- `ffmpeg -version` não respondeu em 8 s no deployment, com o binário
  instalado e a fila de vídeo funcionando. Lançar binário não é coisa de
  `shallow`: o check de arquivos passou a conferir só modelos e mídia, e o
  ffmpeg vai ser exercitado de verdade no nível `deep`.
- A FK da migration 074 (`submissions.proctor_review`) **não existia em
  produção com nome nenhum**, nem no dev do Replit. A explicação mais
  provável apareceu no corte 2 (#392): a FK apontava para uma enumeração
  **semeada no boot**, e o Publish leva o schema antes de o boot semear — o
  diff tenta criar a FK com a tabela-alvo vazia e linhas já apontando para
  ela, e falha. Regra que fica: **FK para enumeração semeada no boot vai numa
  migration separada, num Publish posterior ao que cria a tabela.** A 081
  recria a FK com nome novo e `DROP ... IF EXISTS`, exceção deliberada à regra
  "sem guardas", porque precisava rodar onde a FK existia e onde não (#389).
  Foi o achado que justificou o check.
- A latência de banco em produção é de ~90 ms por ida; os checks de banco em
  série custam ~2 s por relatório. Está dentro do prazo, e é o preço de uma
  conexão só.
- **O primeiro spawn depois de um Publish é muito lento** (primeiro `deep` em
  prod, 08/09: `ffmpeg -version` 15 s, `import mediapipe` 14 s; em regime,
  0,8 s e 2,8 s): o sistema de arquivos do deployment carrega binários sob
  demanda. Por isso o boot **aquece** ffmpeg e Python em segundo plano
  (`lib/warmup.js`), e o `deep` roda os checks externos **depois** da sequência
  de banco — senão o `db` mede a carga que o próprio relatório gerou.

## O que esta capacidade NÃO faz

- **Não roda DDL.** O check de schema é leitura pura, numa transação READ
  ONLY. Tabela ausente é resultado, não exceção. O boot não cria schema —
  [ADR 0001](../decisoes/0001-migrations-nao-rodam-no-boot.md).
- **Não escreve, não gasta, não chama provedor no nível `shallow`.** O nível
  `deep` escreve só numa chave própria do storage (e apaga), gasta centavos e
  **nunca gera fala no Realtime** (só `session.update`) — por isso o token de
  saúde é um alcance próprio, separado do token de análise.
- **Não roda o `deep` de minuto em minuto.** Teto de 12 por hora; a
  monitoração usa o `shallow`.
- **Não aceita token de análise.** Token é credencial de um uso só.
- **Não pega a armadilha do Publish com constraint de mesmo nome** — o check
  confere constraint por **nome**, como o próprio diff do Publish, e mudar a
  definição mantendo o nome passa verde nos dois. Também não confere tipo,
  default ou NOT NULL de coluna. Cobrir isso exige um check de invariantes de
  schema, previsto como corte opcional.
- **Não entrega o relatório sem autenticar.** Validar o token exige o banco; se
  o banco não responde à validação, a resposta é um 503 em prazo com o check de
  banco em falha — o diagnóstico que um 503 já dá — e nada mais.
- **Não testa o navegador.** Nem o `e2e` testará `getUserMedia`, câmera ou
  `MediaRecorder`; isso segue sendo a skill `testar-modo-audio`.
- **Não substitui os testes ponta a ponta.** Mede disponibilidade e integridade
  de dependência, não comportamento pedagógico.
- **Não guarda histórico.** O valor é imediato; histórico exigiria migration e
  política de retenção.

## Cenários

- **Dado** um Publish recém-feito, **quando** a operação chama
  `/admin/health`, **então** vê se alguma migration ficou para trás — antes de
  qualquer aluno abrir uma prova.
- **Dado** um robô de uptime chamando `/healthz` a cada minuto, **quando** o
  processo cai, **então** o alerta dispara sem depender do banco de sessões.
- **Dado** que o `jobRunner` morreu no meio de uma análise, **quando** o check
  de filas roda, **então** a lease vencida aparece como aviso, e não some.
- **Dado** um check que pendura (banco fora), **quando** o prazo estoura,
  **então** ele vira `fail` com motivo, o relatório inteiro ainda sai, e nenhum
  pedido fica pendurado no pool esperando o banco voltar.
- **Dado** um check cujas consultas, somadas, passam do prazo, **quando** o
  relatório volta, **então** a conexão não é devolvida ocupada ao pool: é
  descartada, a consulta é cancelada no servidor, e o check seguinte mede numa
  conexão nova.
- **Dado** um robô configurado com `checks=,,,`, **quando** chama o endpoint,
  **então** recebe 400 — não um relatório vazio com `ok: true`.

## Referência técnica

`lib/health.js` (registro e execução; pool próprio de uma conexão com prazo,
transação READ ONLY com `statement_timeout`), `lib/healthDeep.js` (os checks
de nível `deep`), `lib/schemaExpectations.js` (o
schema esperado a partir das migrations), `lib/jobsHeartbeat.js` (batimento do
executor), `routes/health.js` (endpoints e autenticação com prazo),
`lib/migrations.js#listMigrationStatusReadOnly` (ledger, informativo).
Contrato e fatiamento completo dos cortes seguintes na issue #375.

## Decisões relacionadas

- [ADR 0001 — Migrations não rodam no boot](../decisoes/0001-migrations-nao-rodam-no-boot.md)
- [ADR 0002 — Falhar explícito, sem fallback](../decisoes/0002-falhar-explicito-sem-fallback.md)
- [ADR 0014 — Analytics consulta tabelas-base](../decisoes/0014-analytics-consulta-tabelas-base.md)
- [ADR 0022 — Jobs no banco, janela ociosa](../decisoes/0022-jobs-no-banco-janela-ociosa.md)

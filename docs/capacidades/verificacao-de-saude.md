# Verificação de saúde

> **Estado:** em construção · primeiro corte em 2026-09-07 (nível `shallow`)
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

- **`shallow`** — sem custo e sem efeito: configuração ativa, banco (latência e
  pool), schema materializado, seeds e admin de bootstrap, filas de vídeo e
  retranscrição (com o batimento do executor), binários e modelos, versão do
  termo de consentimento. Alvo: menos de um segundo. É o nível da monitoração
  externa. **É o que existe hoje.**
- **`deep`** — uma ida real a cada dependência externa: storage, o modelo
  principal, transcrição com conferência do texto, síntese de voz, o módulo
  nativo de fiscalização, o sidecar de visão, e a perna servidor↔OpenAI do
  Realtime. Poucos centavos. Roda depois do Publish. *(corte seguinte)*
- **`e2e`** — o relay de voz completo, em produção, sobre um trabalho de saúde
  permanente. Só sob pedido explícito. *(corte seguinte)*

Dois endpoints:

- `GET /healthz` — liveness puro, sem autenticação e sem banco. Responde antes
  do store de sessão; é o que um robô de uptime chama. Por ser aberto, não conta
  nada além de "estou vivo": nem commit, nem versão (isso fica no relatório).
- `GET /admin/health?checks=db,jobs&depth=shallow` — o relatório. Aceita a
  **sessão de administrador** (tela) ou o **token de análise** (monitoração), o
  mesmo mecanismo do acesso analítico. O corpo vem sempre completo; o **status
  HTTP reflete o pior resultado**: 200 sem falhas, 503 com alguma.

## O que cada check de `shallow` pega

| Check | O que descobre, que hoje ninguém descobre a tempo |
|---|---|
| Configuração ativa | qual `policy.yaml` produção está de fato rodando |
| Schema materializado | o **mais valioso pós-Publish**: tabela, coluna, índice ou constraint que alguma migration cria e que **não existe no banco** — com a migration de origem. Confere o catálogo, não o ledger (ver abaixo) |
| Seeds | o schema foi, mas os dados de bootstrap não; ou não há admin global |
| Filas | executor parou (sem tique, lease vencida), falhas nas últimas 24 h, job pendente há mais de uma hora |
| Binários e modelos | deploy sem `ffmpeg`, sem os ONNX, sem o WASM, sem os mp3 do sound check |
| Consentimento | quantos alunos vão reaceitar o termo depois de uma mudança de versão |

## Por que o check de schema não lê o ledger

Em produção, `schema_migrations` **não diz a verdade**: o Publish do Replit
materializa o schema por diff dev→prod e não escreve uma linha no ledger
([ADR 0001](../decisoes/0001-migrations-nao-rodam-no-boot.md)). Medido em
07/09/2026: produção tinha 8 linhas no ledger e as 80 migrations no banco. Um
check que comparasse arquivos com o ledger acusaria 72 "pendentes" para sempre,
e uma monitoração que grita para sempre é uma monitoração desligada.

O que se confere é o **catálogo**: as migrations são lidas em ordem e dizem o
que o schema deveria ter — tabelas, colunas (inclusive as declaradas dentro do
`CREATE TABLE`), índices e constraints, com os DROPs e RENAMEs aplicados e com
o nome que o Postgres dá às constraints sem nome; o check pergunta ao banco o
que existe e lista o que falta, apontando a migration que o criou. Em dev, onde
o ledger é a verdade, ele aparece como informação. O invariante que segura o
parser é um teste: o banco de dev, migrado por definição, tem de dar zero
ausências. Detalhe em `lib/schemaExpectations.js`.

Cada ausência acusada vem com o que o catálogo **tem** naquela tabela, do mesmo
tipo — é o que distingue "falta" de "existe com outro nome", que foi a dúvida
da primeira medição em produção (#389).

## O que a primeira medição em produção ensinou (07/09/2026)

- O deployment do Replit não leva o `.git`: o commit saía `null`. O passo de
  `build` em `.replit` grava `.build-commit`, que o relatório lê.
- A sonda do `ffmpeg` com 2 s estourava em toda chamada, com o binário
  instalado e a fila de vídeo funcionando. A sonda passou a 8 s e diz o que
  aconteceu (tempo, código do erro, sinal), porque "não achei" e "achei mas
  demorou" pedem ações diferentes. Por isso o check `assets` tem orçamento
  próprio de 9 s, acima do padrão de 3 s dos demais: **o cliente da
  monitoração precisa esperar pelo menos 10 s** pela resposta. Com a sonda
  bem-sucedida, a versão fica memorizada e as chamadas seguintes custam
  milissegundos.
- A latência de banco em produção é de ~90 ms por ida; os checks de banco em
  série custam ~2 s por relatório. Está dentro do prazo, e é o preço de uma
  conexão só.

## O que esta capacidade NÃO faz

- **Não roda DDL.** O check de schema é leitura pura, numa transação READ
  ONLY. Tabela ausente é resultado, não exceção. O boot não cria schema —
  [ADR 0001](../decisoes/0001-migrations-nao-rodam-no-boot.md).
- **Não escreve, não gasta, não chama provedor no nível `shallow`.** Por isso o
  token de análise, que é somente-leitura por construção, serve sem ampliar o
  que ele já pode. Quando o nível `deep` entrar, isso muda — e a decisão sobre o
  alcance do token (a proposta de `scope`, aprovada em 07/09) precisa vir
  **antes**, com a tela de tokens do admin mudando junto.
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
transação READ ONLY com `statement_timeout`), `lib/schemaExpectations.js` (o
schema esperado a partir das migrations), `lib/jobsHeartbeat.js` (batimento do
executor), `routes/health.js` (endpoints e autenticação com prazo),
`lib/migrations.js#listMigrationStatusReadOnly` (ledger, informativo).
Contrato e fatiamento completo dos cortes seguintes na issue #375.

## Decisões relacionadas

- [ADR 0001 — Migrations não rodam no boot](../decisoes/0001-migrations-nao-rodam-no-boot.md)
- [ADR 0002 — Falhar explícito, sem fallback](../decisoes/0002-falhar-explicito-sem-fallback.md)
- [ADR 0014 — Analytics consulta tabelas-base](../decisoes/0014-analytics-consulta-tabelas-base.md)
- [ADR 0022 — Jobs no banco, janela ociosa](../decisoes/0022-jobs-no-banco-janela-ociosa.md)

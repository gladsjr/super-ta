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
  pool), migrations pendentes, seeds e admin de bootstrap, filas de vídeo e
  retranscrição, binários e modelos, versão do termo de consentimento. Alvo: menos
  de um segundo. É o nível da monitoração externa. **É o que existe hoje.**
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
| Migrations | o **mais valioso pós-Publish**: arquivo que o diff dev→prod não levou |
| Seeds | o schema foi, mas os dados de bootstrap não; ou não há admin global |
| Filas | executor parou (lease vencida), falhas nas últimas 24 h, fila crescendo |
| Binários e modelos | deploy sem `ffmpeg`, sem os ONNX, sem o WASM, sem os mp3 do sound check |
| Consentimento | quantos alunos vão reaceitar o termo depois de uma mudança de versão |

## O que esta capacidade NÃO faz

- **Não roda DDL.** O check de migrations é leitura pura: lista os arquivos, lê
  `schema_migrations`, compara. Tabela ausente é resultado, não exceção. O boot
  não cria schema — [ADR 0001](../decisoes/0001-migrations-nao-rodam-no-boot.md).
- **Não escreve, não gasta, não chama provedor no nível `shallow`.** Por isso o
  token de análise, que é somente-leitura por construção, serve sem ampliar o
  que ele já pode. Quando o nível `deep` entrar, isso muda — e a decisão sobre o
  alcance do token (a proposta de `scope`) precisa vir **antes**.
- **Não pega a armadilha do Publish com constraint de mesmo nome** — o check
  compara nomes de arquivo, e mudar a definição de uma constraint mantendo o nome
  passaria verde. Cobrir isso exige um check de invariantes de schema, previsto
  como corte opcional.
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
  **então** ele vira `fail` com motivo, e o relatório inteiro ainda sai.

## Referência técnica

`lib/health.js` (registro e execução), `routes/health.js` (endpoints e
autenticação), `lib/migrations.js#listMigrationStatusReadOnly`.
Contrato e fatiamento completo dos cortes seguintes na issue #375.

## Decisões relacionadas

- [ADR 0001 — Migrations não rodam no boot](../decisoes/0001-migrations-nao-rodam-no-boot.md)
- [ADR 0002 — Falhar explícito, sem fallback](../decisoes/0002-falhar-explicito-sem-fallback.md)
- [ADR 0014 — Analytics consulta tabelas-base](../decisoes/0014-analytics-consulta-tabelas-base.md)
- [ADR 0022 — Jobs no banco, janela ociosa](../decisoes/0022-jobs-no-banco-janela-ociosa.md)

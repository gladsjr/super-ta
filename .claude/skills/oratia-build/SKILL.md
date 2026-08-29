---
name: oratia-build
description: >-
  Constrói o artefato executável do ORATIA: imagem Docker, dependências Node no
  volume do Linux e migrations do banco. Cobre os alvos dev e pack, o cache de
  camadas, os módulos nativos (bcrypt, onnxruntime-node) e o estado do schema.
  Use quando o pedido for construir, reconstruir, instalar dependências,
  atualizar o lockfile, aplicar ou conferir migrations — frases como "rebuild da
  imagem", "instalar as dependências", "atualizar o package-lock", "aplicar as
  migrations", "o módulo nativo não carrega", "validar o empacotamento". NÃO use
  para preparar a máquina (use oratia-ambiente), para subir e validar a
  aplicação (use oratia-deploy) nem para escrever código ou migration nova (use
  oratia-improve).
---

# Build do ORATIA

Não há build de frontend: o front é HTML e JS servidos como estáticos.
"Construir" aqui significa três coisas independentes, nesta ordem de
dependência:

1. **imagem** — sistema operacional e binários de runtime;
2. **dependências** — `node_modules` do Linux, no volume;
3. **schema** — migrations aplicadas no banco.

Cada uma tem seu comando e sua verificação. Rode todos a partir da raiz do
workspace.

## 1. Imagem

```bash
docker compose build app
```

**Verificação** — a versão precisa vir da imagem, não do host:

```bash
docker compose run --rm --no-deps app node --version
```

Espere uma 20.x (verificado: `v20.20.2`). Saindo a versão do host, o comando
rodou fora do container.

O `Dockerfile` tem dois alvos:

| Alvo | Para que serve | Código |
|---|---|---|
| `dev` | dia a dia | chega por bind mount; a imagem não o contém |
| `pack` | validar o empacotamento | copiado para dentro da imagem no build |

Reconstrua quando mudar o `Dockerfile`. **Mudar código da aplicação não exige
rebuild** no alvo `dev` — o bind mount já reflete o disco; basta
`docker compose restart app`.

O que a imagem acrescenta ao Node 20, e por quê:

- **ffmpeg** — extração de quadros do proctoring e processamento de áudio. É a
  dependência que mais falta no host: não vem em Windows nem em macOS.
- **ca-certificates** — chamadas HTTPS à API da OpenAI.
- **tini** como PID 1 — encaminha sinais e recolhe zumbis. Sem ele o `node`
  roda como PID 1, ignora SIGTERM, e todo `down` espera o timeout de 10s.

## 2. Dependências

```bash
docker compose run --rm deps
```

Instala no volume `super-ta_node-modules-linux`. **Repita sempre que o
`package-lock.json` mudar** — inclusive depois de um `git pull`.

Usa `npm ci`, não `install`: obedece ao lockfile e falha se ele divergir do
`package.json`, que é o comportamento desejado num ambiente reprodutível.

**`--foreground-scripts` é deliberado.** Sem ele, a saída dos scripts de
instalação dos módulos nativos é engolida, e uma falha só reaparece muito
depois como "módulo não carrega" — longe da causa. Com ele você vê o que
acontece de verdade:

- `bcrypt` compila via `node-gyp-build`;
- `onnxruntime-node` **baixa da nuget** os binários nativos, incluindo
  providers de CUDA, mesmo sem GPU. São centenas de megabytes: a primeira
  execução demora, e numa rede restrita é aqui que ela falha.

**Verificação** — termina com `added N packages` e sem erro (verificado: 231
pacotes).

### Por que o volume, e não a pasta

Duas razões independentes, ambas medidas:

- **Plataforma.** Os binários nativos que o host compila (Windows ou macOS) não
  carregam no Linux do container.
- **Velocidade.** Escrita no bind mount é **77x mais lenta** (583 contra 45.145
  arquivos por segundo, atravessando a fronteira Windows↔WSL2). Um `npm ci` com
  dezenas de milhares de arquivos é inviável ali.

Módulo nativo que não carrega quase sempre significa volume populado a partir
do host: `docker compose down -v` e refaça imagem, banco e dependências.

## 3. Migrations

```bash
docker compose run --rm migrate
```

**Verificação:**

```bash
docker compose run --rm migrate npm run db:migrate -- status
```

Termina em `N/N aplicadas, 0 pendentes` (verificado: 79/79 a partir de um banco
vazio).

Três regras que vêm do tronco e não se contornam aqui:

- **O boot não roda DDL.** É decisão arquitetural registrada em ADR, não
  esquecimento. Migração é passo explícito, sempre.
- **Nunca use `npm run dev` dentro do container.** O `predev` chama `db:up`,
  que tenta iniciar o Docker Desktop **do host** de dentro do container. Os
  serviços `db`, `deps`, `migrate` e `app` fazem o equivalente, separados.
- **Nunca edite uma migration já aplicada.** Para corrigir, crie a próxima. O
  detalhe está no `AGENTS.md` do tronco e na skill `oratia-improve`.

## Validar o empacotamento

Verifica que a aplicação se constrói e sobe **sem nada do host** — código
dentro da imagem, dependências instaladas no build, nenhum bind mount. É o
teste de que o ambiente é reprodutível numa máquina limpa.

```bash
docker compose --profile pack up -d --build pack
```

**Verificação** (porta separada, para rodar ao lado do `app`):

```bash
curl -s http://localhost:5098/oral/ping
```

Responde `ok`. Encerre com `docker compose --profile pack down pack`.

Rode isto antes de afirmar que o ambiente está reprodutível, e depois de mexer
no `Dockerfile` ou nas dependências.

## Ordem quando algo está estranho

Do mais barato ao mais caro, parando no primeiro que resolver:

```bash
docker compose restart app                          # código mudou
docker compose run --rm deps                        # lockfile mudou
docker compose run --rm migrate                     # schema mudou
docker compose build app                            # Dockerfile mudou
docker compose down -v && docker compose up -d db   # estado corrompido — APAGA O BANCO
```

O último apaga o banco e as dependências. Confirme com o usuário antes, e
depois refaça os passos 5 a 8 do `INSTALACAO.md`.

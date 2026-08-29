---
name: oratia-conhecimento
description: >-
  Conhecimento operacional do ORATIA que não é dedutível do código: topologia do
  ambiente local, credenciais de teste, armadilhas verificadas na prática,
  decisões do workspace e seu porquê, e divergências conhecidas entre a
  documentação do tronco e a realidade. Use quando o pedido for entender por que
  algo é como é, onde registrar uma lição aprendida, qual credencial usar em
  teste, ou quando um comportamento surpreendente precisar de explicação —
  frases como "por que isso é assim", "qual usuário uso para testar", "isso é
  bug ou é de propósito", "onde eu documento isso", "a documentação está
  errada", "que decisões foram tomadas aqui". NÃO use para executar o ambiente
  (use oratia-ambiente, oratia-build ou oratia-deploy) nem para as convenções de
  código da aplicação, que vivem em super-ta/AGENTS.md.
---

# Conhecimento operacional do ORATIA

O que só se descobre operando. Cada item aqui custou uma falha real; nenhum é
dedutível da leitura do código.

## Onde cada tipo de conhecimento mora

Uma fonte por assunto. Antes de escrever, decida qual é:

| Tipo de conhecimento | Onde vive |
|---|---|
| Armadilha de ambiente, build ou deploy **deste workspace** | esta skill |
| Como montar, construir, subir | `oratia-ambiente`, `oratia-build`, `oratia-deploy` |
| Pré-requisito, layout, segredo, ordem de bootstrap | `MANIFESTO.yaml` |
| Comando de instalação e diagnóstico | `INSTALACAO.md` |
| Armadilha de infraestrutura **do tronco** (plataforma de hospedagem, binários) | `super-ta/.agents/memory/` — já são 19 notas indexadas em `MEMORY.md` |
| Convenção de código, migration, prompt | `super-ta/AGENTS.md` |
| Decisão de arquitetura da aplicação | ADR em `super-ta/docs/decisoes/` |

**Não replique aqui o que está em `super-ta/.agents/memory/`.** Aquilo é
conhecimento do produto e viaja com o código; isto é conhecimento do workspace
de SDLC. Na dúvida: a lição vale para quem só tem o tronco? Então é lá.

**Nada de conhecimento durável na memória do agente.** Ela não viaja entre
máquinas nem chega ao próximo colaborador. O que precisa durar vira artefato
versionado.

## Credenciais de teste

Semeadas no boot por `INITIAL_USERS`, default
`professor:senha123,admin:admin123`. São **descartáveis, de desenvolvimento**;
nunca reaproveite em ambiente exposto.

| Usuário | Senha | Papel real |
|---|---|---|
| `professor` | `senha123` | **admin global** |
| `admin` | `admin123` | usuário comum, apesar do nome |

### A armadilha do admin global

**O usuário chamado `admin` não é administrador.** `professor` é.

O `seedBootstrapAdmin` promove o **primeiro usuário por id** quando não há
nenhum admin global — e `INITIAL_USERS` começa por `professor`. Verificado no
banco: `professor` (id 1) tem `admin_global`; `admin` (id 2) não tem nada.

Sintoma: login com `admin` funciona, e aí `POST /admin/works` devolve
`403 forbidden_tokenless_work`, sem dizer que o problema é de papel.

Duas consequências que não são óbvias:

- `BOOTSTRAP_ADMIN` escolhe o alvo, **mas só no primeiro boot com banco
  limpo**: a função sai cedo se já existir qualquer admin global. Definir a
  variável depois não muda nada.
- Trocar a ordem de `INITIAL_USERS` também só tem efeito antes do primeiro
  boot.

Conferindo quem é admin global:

```bash
docker exec superta-db psql -U superta -d superta -tAc "SELECT u.username FROM memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id WHERE r.key='admin_global';"
```

### A armadilha do seed de senha

O seed **só cria usuário que ainda não existe**. Mudar a senha no `.env` depois
do primeiro boot não a reaplica. Para trocar de verdade: remova o usuário do
banco, ou continue com a senha antiga.

## Topologia do ambiente local

```
host                          container `app`              container `superta-db`
─────                         ─────────────────            ──────────────────────
localhost:5099   ──────────►  0.0.0.0:5099                 postgres 16.15
                              node 20.20.2 (linux/x64)     db `superta`
./super-ta       ──bind────►  /app                         volume super-ta_superta-pgdata
volume nomeado   ──────────►  /app/node_modules
                                     │
                                     └──── db:5432 ────────►
```

- **`DATABASE_URL` difere por origem.** De dentro da rede do Compose é
  `db:5432`; do host seria `localhost:5432`. Quem determina é a topologia, por
  isso o valor vive no compose e não no `.env`.
- **Um só container Postgres, um só database (`superta`).** O `container_name`
  é fixo no compose do tronco.
- **A porta interna é sempre 5099**; o que varia por colaborador é a publicada
  no host (`ORATIA_APP_PORT`).

## Contratos com o exterior

| Integração | Como entra | Sem ela |
|---|---|---|
| **OpenAI** (Responses, Files, Vector Stores, STT, TTS, Realtime) | `ORATIA_OPENAI_TOKEN` → o compose entrega como `OPENAI_API_KEY` | O ambiente sobe e responde; nenhuma jornada cognitiva funciona |
| **PostgreSQL 16** | serviço `db` do compose | Nada sobe |
| **ffmpeg** | embutido na imagem | Proctoring de vídeo e processamento de áudio indisponíveis |
| **Sidecar Python** (MediaPipe/OpenCV) | `requirements.txt` do tronco, **não instalado na imagem** | Proctoring de mãos indisponível — o sistema segue funcionando (fail-open) |

**O sidecar Python é uma ausência deliberada.** MediaPipe e OpenCV acrescentam
centenas de megabytes para uma capacidade opcional que falha em aberto por
projeto. Precisando dele, acrescente ao `Dockerfile` — e registre a decisão
aqui.

## Decisões deste workspace, e o porquê

| Decisão | Por quê | O que aconteceria sem ela |
|---|---|---|
| Tudo em containers | O host do colaborador não precisa da versão certa de nada. Resolveu de uma vez Node 24-vs-20, ffmpeg ausente e binários nativos | Cada colaborador depuraria a própria máquina |
| Containerização nesta branch, não no tronco | É ferramental de SDLC; o repositório de código fica intocado | PR de produto misturado com ambiente |
| `include:` do compose do tronco | Fonte única da definição do banco: imagem, credenciais e healthcheck vêm de lá | Duas definições do banco divergindo em silêncio |
| `name: super-ta` fixo | Sem ele o Compose deriva o nome do projeto da PASTA, e o nome da pasta do workspace é livre | O volume do banco mudaria de nome por colaborador — e por diretório de onde se roda |
| `node_modules` em volume | Binários nativos de outra plataforma **e** escrita 77x mais lenta no bind mount | Módulo que não carrega, e `npm ci` inviável |
| Porta 5099, não a 5000 do código | No macOS a 5000 é do AirPlay Receiver | Ambiente que sobe no Windows e falha no Mac |
| Verificador em Node, não em shell | Node roda igual nos três sistemas. Bash não é padrão no Windows; PowerShell não é padrão em Linux e macOS | Um script por sistema, divergindo |
| Lista de pré-requisitos no manifesto, não no script | O script é só executor — uma fonte da verdade | Lista dupla, divergindo |
| Ponte `ORATIA_OPENAI_TOKEN` → `OPENAI_API_KEY` | O código só conhece o segundo nome. A ponte permite que a chave viva no ambiente da máquina, sem virar arquivo | Alterar o tronco só para renomear uma variável |

## Armadilhas verificadas na prática

**Checar porta por `bind` dá falso OK no Windows.** Com a aplicação publicada e
respondendo na 5099, o `listen` **sucede** — tanto em `127.0.0.1` quanto em
`0.0.0.0`. O Docker Desktop publica por um proxy que não disputa o bind com o
host. O idioma comum (`EADDRINUSE`) é inútil aqui: teste **conexão** primeiro.

**Git Bash converte caminhos de container.** `/app/x` vira
`C:/Program Files/Git/app/x` ao ser repassado ao `docker`. Sintoma:
`Cannot find module '/app/C:/Program Files/Git/...'`. Correção:
`MSYS_NO_PATHCONV=1` antes do comando.

**npm 11 bloqueia scripts de instalação.** No host com npm 11, `bcrypt` e
`onnxruntime-node` têm o install script barrado pela política `allow-scripts`,
com o aviso perdido no fim de um log longo. Aqui funcionaram por haver
*prebuild* — numa plataforma sem prebuild, quebrariam. Dentro do container o
npm é 10.8.2 e o problema não existe. É mais uma razão para não instalar
dependências no host.

**`onnxruntime-node` baixa CUDA sem GPU.** O postinstall busca na nuget os
providers nativos, CUDA e TensorRT inclusos. São centenas de megabytes: a
primeira instalação demora, e numa rede restrita é aqui que ela falha.

**`npm run dev` não funciona dentro do container.** O `predev` chama `db:up`,
que tenta iniciar o Docker Desktop **do host**. Use os serviços separados.

**O bind mount atravessando WSL2 é 77x mais lento na escrita.** Medido: 583
contra 45.145 arquivos por segundo. Vale para qualquer operação com muitos
arquivos pequenos.

## Divergências entre a documentação do tronco e a realidade

Verificadas por execução. Não "corrija" o ambiente para casar com elas.

| O documento diz | A realidade | Como tratar |
|---|---|---|
| `AGENTS.md`: clone do Claude em `…/ORATIA/super-ta-repo`, banco `oratia_claude`, porta `:5000` | A pasta é `super-ta`, o banco é `superta`, a porta é 5099 | Aquela tabela descreve **uma** máquina, com três agentes e bancos legados que aqui não existem. A **regra** de isolamento é válida; a **tabela** não é fonte para este workspace |
| `.env.example` do tronco: `PORT=5099` | O default do código é 5000 (`lib/config.js`) | Ambos "certos": o código tem um default, o exemplo sugere outro. Aqui vale 5099, pelo AirPlay do macOS |
| Skill antiga: "Node precisa ser 20.x" | O host tem 24 e o `npm install` passa | Irrelevante agora: a versão que importa é a da imagem |
| `README.md` do workspace: clone por `git@github.com:…` | O remote real usa um alias SSH | O alias é configuração de máquina; a URL genérica no roteiro está correta |

## Ao aprender algo novo

1. **Decida onde mora** pela tabela do topo. É do tronco? Vai para
   `super-ta/.agents/memory/`, com a linha no `MEMORY.md` de lá.
2. **Registre sintoma, causa e correção** — os três. Só a correção não ajuda
   quem encontrar o sintoma sem saber a causa.
3. **Diga como verificou.** Não tendo verificado, escreva isso.
4. **Se o fato aparece em outro arquivo**, veja a matriz de propagação em
   `oratia-ambiente` e propague na mesma alteração.
5. **Commit na raiz do workspace** — a menos que a lição seja do tronco, e aí é
   commit em `super-ta/`, em branch de feature.

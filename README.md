# ORATIA — Workspace de SDLC

> Branch **`oratia-sdlc`** do repositório `super-ta`. Não contém código da
> aplicação: contém o **ferramental de trabalho** (skills e documentação de
> processo) que orienta o desenvolvimento, a evolução e os testes do ORATIA.

## Propósito

O ORATIA é um sistema de avaliação de aprendizagem por entrevista — um monólito
Node.js cuja camada cognitiva roda sobre modelos de IA. Trabalhar nele exige
conhecer um conjunto de regras que **não são dedutíveis do código**: princípios
arquiteturais deliberados (falhar explicitamente em vez de degradar em
silêncio), invariantes de segurança (o gabarito nunca chega ao navegador; a
avaliação interna nunca chega ao aluno) e um processo de mudança com regras
duras (migrations nunca editadas depois de aplicadas; todo prompt registrado no
mapa único de prompts).

Este branch existe para que esse conhecimento seja **executável em vez de
tribal**: as regras vivem em skills que o agente de IA carrega automaticamente,
em vez de depender de alguém lembrar de explicá-las a cada nova pessoa.

### Por que um branch órfão

`oratia-sdlc` não compartilha nenhum commit com `main` ou `release` — é uma raiz
de história independente, no mesmo repositório. A separação é intencional:

- **O ferramental evolui em ritmo próprio.** Ajustar uma skill não é mudança de
  produto e não deve aparecer no histórico do tronco nem disputar revisão com
  código de aplicação.
- **O tronco permanece limpo.** Nada de SDLC entra em `main`, e nenhum merge
  acidental é possível entre históricos sem ancestral comum.
- **Um único repositório.** Quem tem acesso ao código tem acesso ao ferramental,
  sem gerir permissões em dois lugares.

## Estrutura do workspace

O workspace é um diretório que contém **dois repositórios independentes**: ele
próprio (neste branch) e, aninhado, um clone do tronco principal.

```
<workspace>/                     # repositório deste branch (oratia-sdlc)
├── CLAUDE.md                    # steering: mapa e regras invioláveis
├── PRIMER.md                    # conduta: os dois ciclos e o portão de revisão
├── METAS.md                     # metas do produto (base do revisor)
├── MANIFESTO.yaml               # fonte da verdade do ambiente
├── INSTALACAO.md                # roteiro de instalação e diagnóstico
├── docker-compose.yml           # ambiente em containers (inclui o compose do tronco)
├── Dockerfile                   # imagem da aplicação (Node 20 + ffmpeg)
├── .env.example                 # modelo da configuração local
├── tools/
│   ├── verificar-prerequisitos.mjs
│   └── verificar-atualizacao-sdlc.mjs
├── .claude/
│   ├── settings.json            # hook de atualização no início da sessão
│   ├── agents/
│   │   └── oratia-revisor.md    # revisor independente (só leitura)
│   └── skills/                  # skills carregadas automaticamente
│       ├── oratia-revisao/
│       ├── oratia-ambiente/
│       ├── oratia-build/
│       ├── oratia-deploy/
│       ├── oratia-conhecimento/
│       └── oratia-improve/
├── docs/
│   └── analise-arquitetural.md  # visão técnica e análise crítica do sistema
├── .gitignore                   # ignora o clone do tronco
├── README.md
└── super-ta/                    # repositório do TRONCO (main)
                                 # clone independente — ignorado por este branch
```

O nome do diretório do workspace é livre; nada no ferramental depende dele. O
único nome que importa é **`super-ta`** para o clone do tronco, porque é assim
que o `.gitignore` o exclui.

## Configuração do ambiente local

**Todo o ambiente roda em containers.** Você não precisa de Node, ffmpeg,
Python nem PostgreSQL instalados na máquina para a aplicação funcionar — a
imagem traz tudo, na versão certa.

### Pré-requisitos

| Item | Necessário para | Obrigatório |
|---|---|---|
| Git | Obter os dois repositórios | sim |
| Docker + Compose v2.20+ | Todo o ambiente. No Windows, com backend **WSL2** | sim |
| Node.js 18+ | Rodar o verificador de pré-requisitos (só o ferramental) | recomendado |
| Claude Code | Carregar as skills | opcional |
| Chave de API da OpenAI | Jornadas de entrevista, avaliação e voz | opcional |

A chave da OpenAI **não** bloqueia o ambiente: sem ela tudo sobe e responde,
e só as jornadas que conversam com o modelo ficam indisponíveis.

A lista completa, com o teste objetivo de cada item, está em
[`MANIFESTO.yaml`](MANIFESTO.yaml) — e é executada por
`node tools/verificar-prerequisitos.mjs`.

### 1. Clonar o workspace

```bash
git clone --branch oratia-sdlc --single-branch git@github.com:gladsjr/super-ta.git oratia
```

`--single-branch` evita baixar a história do tronco: como este branch é órfão, o
clone fica mínimo.

### 2. Clonar o tronco dentro do workspace

```bash
cd oratia
git clone git@github.com:gladsjr/super-ta.git super-ta
```

O diretório `super-ta/` é ignorado por este branch — os dois repositórios
convivem sem interferência. O nome **precisa** ser `super-ta`: é assim que o
`.gitignore` o exclui.

### 3. Configurar a identidade de commit

Faça isso **em cada um dos dois repositórios**, com configuração local (não
global), sobretudo se a máquina hospedar trabalho de mais de uma organização:

```bash
git config user.name "Seu Nome"
git config user.email "seu.email@organizacao"
```

Se você mantém várias chaves SSH, fixe explicitamente qual usar neste
repositório — sem isso o cliente SSH pode oferecer outra chave e autenticar com
a conta errada:

```bash
git config core.sshCommand "ssh -o IdentitiesOnly=yes -i ~/.ssh/sua_chave"
```

Quando a chave está carregada no agent do sistema em vez de legível em disco,
aponte para o arquivo público correspondente (`~/.ssh/sua_chave.pub`).

### 4. Subir o ambiente

O roteiro completo, com verificação a cada passo e tabela de diagnóstico, está
em [`INSTALACAO.md`](INSTALACAO.md). Em resumo:

```bash
cp .env.example .env
node tools/verificar-prerequisitos.mjs
docker compose build app
docker compose up -d db
docker compose run --rm deps
docker compose run --rm migrate
docker compose up -d app
curl -s http://localhost:5099/oral/ping
```

O último comando responde `ok`. Ou peça ao Claude Code — a skill
**`oratia-deploy`** conduz o processo e diagnostica as falhas:

```
sobe o oratia localmente
```

## Skills disponíveis

| Skill | Quando é acionada | O que entrega |
|---|---|---|
| **`oratia-revisao`** | Submeter plano ou implementação ao portão de revisão; entender um apontamento; decidir se está pronto | Como submeter ao `oratia-revisor`, como ler os graus BAIXO/MODERADO/CRÍTICO, o laço de reformulação e quando escalar |
| **`oratia-ambiente`** | Montar em máquina nova, diagnosticar falha de ambiente, decidir onde mudar uma configuração | Pré-requisitos, Docker sobre WSL2, volumes e portas, e a **matriz de propagação** dos fatos que aparecem em mais de um arquivo |
| **`oratia-build`** | Construir imagem, instalar dependências, aplicar migrations, validar empacotamento | Os três estágios do build com verificação própria, os módulos nativos e o porquê do volume |
| **`oratia-deploy`** | Subir, rodar, reiniciar ou validar a aplicação | Sequência de validação real (health, login, escrita no banco), operação do dia a dia e diagnóstico |
| **`oratia-conhecimento`** | Entender por que algo é como é, onde registrar uma lição, qual credencial usar | Topologia, contratos de integração, credenciais de teste, armadilhas verificadas e divergências conhecidas da documentação |
| **`oratia-improve`** | Implementar funcionalidade, corrigir bug, refatorar, mexer em prompt, alterar schema | Princípios inegociáveis, invariantes de segurança, processo de mudança e as frentes do roadmap |

O tronco traz ainda a skill `testar-modo-audio`, versionada em `super-ta/` e
válida apenas ao trabalhar naquele repositório.

As skills deste branch são descobertas quando a sessão do Claude Code é aberta
**na raiz do workspace** — e valem também para o trabalho feito dentro de
`super-ta/`, que é justamente o efeito desejado.

## Fluxo de trabalho: dois repositórios, dois históricos

A regra é simples e não tem exceção: **cada mudança pertence a um repositório
só.**

| Você mudou | Commit em | Branch |
|---|---|---|
| Uma skill, este README, documentação de processo, ferramental | Raiz do workspace | direto em `oratia-sdlc` |
| Código, migrations, prompts, testes da aplicação | `super-ta/` | branch derivada de **`main`** → PR |

Toda evolução de produto deriva de `main`, que é o default do repositório —
nunca de `release`, nunca commitando direto em `main`.

**Mudança de produto que altera como o ambiente é montado, construído, subido
ou diagnosticado obriga a atualizar o SDLC na mesma entrega.** Os gatilhos
concretos estão no [`PRIMER.md`](PRIMER.md).

Além disso, **todo plano e toda implementação passam por revisão independente**
antes de serem dados por entregues — o agente `oratia-revisor` julga contra o
objetivo declarado e a base normativa, e devolve apontamentos BAIXO, MODERADO
ou CRÍTICO. Um MODERADO ou CRÍTICO reprova. O procedimento está na skill
`oratia-revisao`.

Antes de commitar, confirme onde você está — o diretório de trabalho determina
qual repositório recebe o commit:

```bash
git rev-parse --show-toplevel   # qual repositório
git branch --show-current       # qual branch
```

O `.gitignore` deste branch impede que `super-ta/` seja rastreado mesmo em um
`git add -A` distraído. A proteção inversa não existe: **não crie skills dentro
de `super-ta/.claude/skills/`** a menos que a intenção seja versioná-las no
tronco.

### Evoluir uma skill

Edite o `SKILL.md` correspondente e commite neste branch. Uma skill é um arquivo
Markdown com um cabeçalho YAML (`name` e `description`) seguido das instruções —
a `description` é o que determina quando o agente a aciona, então descreva os
gatilhos em linguagem natural, incluindo o que **não** deve acioná-la.

## Referências

- [`docs/analise-arquitetural.md`](docs/analise-arquitetural.md) — visão técnica
  do sistema com diagramas, análise crítica de segurança, escalabilidade,
  dependências e riscos.
- No tronco (`super-ta/`): `replit.md` (visão arquitetural corrente),
  `CLAUDE.md` (regras duras de processo) e `docs/architecture.md` (ciclo do
  turno e mapa único de prompts).

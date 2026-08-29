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
├── .claude/
│   └── skills/                  # skills carregadas automaticamente
│       ├── oratia-improve/
│       └── oratia-local-deploy/
├── docs/
│   └── analise-arquitetural.md  # visão técnica e análise crítica do sistema
├── .gitignore                   # ignora o clone do tronco
├── README.md
└── super-ta/                    # repositório do TRONCO (main/release)
                                 # clone independente — ignorado por este branch
```

O nome do diretório do workspace é livre; nada no ferramental depende dele. O
único nome que importa é **`super-ta`** para o clone do tronco, porque é assim
que o `.gitignore` o exclui.

## Configuração do ambiente local

### Pré-requisitos

| Item | Necessário para |
|---|---|
| Git | Ambos os repositórios |
| Node.js 20 | Executar a aplicação |
| Docker (ou runtime OCI equivalente) | PostgreSQL local |
| Claude Code | Carregar as skills |
| Chave de API da OpenAI | **Qualquer** jornada funcional — sem ela nada roda |

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
convivem sem interferência.

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

### 4. Preparar a aplicação

A partir daqui, peça ao Claude Code — a skill **`oratia-local-deploy`** conduz o
processo (banco em contêiner, `.env`, migrations, verificação de fumaça) e traz
a tabela de diagnóstico dos erros mais comuns:

```
sobe o oratia localmente
```

Ou manualmente, dentro de `super-ta/`: copie `.env.example` para `.env`,
preencha as variáveis obrigatórias e execute `npm install` seguido de
`npm run dev`.

## Skills disponíveis

| Skill | Quando é acionada | O que entrega |
|---|---|---|
| **`oratia-improve`** | Implementar funcionalidade, corrigir bug, refatorar, criar agente, mexer em prompt, alterar schema, avançar o roadmap | Princípios inegociáveis, invariantes de segurança, processo de mudança (migrations, mapa de prompts, helpers obrigatórios), as 12 frentes do roadmap, débitos conhecidos e a matriz de validação por tipo de mudança |
| **`oratia-local-deploy`** | Subir, rodar ou testar o sistema localmente; diagnosticar falhas de ambiente | Passo a passo do ambiente local, capacidades opcionais (fiscalização por vídeo, prova oral) e diagnóstico de erros comuns |

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
| Uma skill, este README, documentação de processo | Raiz do workspace | `oratia-sdlc` |
| Código, migrations, prompts, testes da aplicação | `super-ta/` | Branch de feature a partir de `main`/`release` → PR |

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

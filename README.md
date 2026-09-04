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
│   ├── verificar-atualizacao-sdlc.mjs
│   └── validar-jornada-ia.mjs      # jornada com IA (gasta API)
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

## Montar o ambiente

**Todo o ambiente roda em containers.** Você não precisa de Node, ffmpeg,
Python nem PostgreSQL instalados na máquina para a aplicação funcionar — a
imagem traz tudo, na versão certa.

Esta seção é escrita para ser executada **por um agente**. Ele consegue fazer a
maior parte sozinho, e o que exige uma pessoa está nomeado em *Quem faz o quê* —
concentrado na *etapa 1*, com duas exceções que a etapa 2 declara: escrever no
`~/.ssh/config`, que é arquivo fora do workspace, e escolher o método de acesso.
Quem prefere montar à mão segue as mesmas etapas na mesma ordem.

### O que precisa existir

| Item | Necessário para | Para montar |
|---|---|---|
| **Acesso ao repositório** | Obter os dois repositórios e enviar trabalho de volta — por SSH ou HTTPS, à sua escolha | **sim** |
| Git | Obter os dois repositórios | **sim** |
| Docker + Compose v2.20+ | Todo o ambiente. No Windows, com backend **WSL2** | **sim** |
| Node.js 18+ | Rodar o ferramental de `tools/` — o verificador e o hook de atualização | recomendado |
| Claude Code | Carregar as skills | opcional |
| Chave de API da OpenAI | Jornadas de entrevista, avaliação e voz | opcional |

A lista executável é a do [`MANIFESTO.yaml`](MANIFESTO.yaml) (`prerequisitos:`),
e é ela que `node tools/verificar-prerequisitos.mjs` roda. Esta tabela é um
resumo de leitura, e a coluna **Para montar** traduz o `nivel:` de lá assim:
`bloqueio` → **sim**; `aviso` cuja falta degrada o **ferramental** →
*recomendado*; `aviso` cuja falta indisponibiliza uma **capacidade do produto** →
*opcional*. O Claude Code não figura no manifesto porque não é pré-requisito do
ambiente: sem ele o ambiente sobe igual, só não há agente para conduzir.

Duas leituras que a tabela não dá e que importam:

- **A chave da OpenAI não bloqueia nada do ambiente.** Sem ela tudo sobe e
  responde; só as jornadas que conversam com o modelo ficam indisponíveis.
- **O acesso ao repositório é `aviso` no manifesto e "sim" aqui, e as duas
  classificações estão certas.** O manifesto classifica pelo efeito no ambiente
  **já montado**, que sobe e roda sem tocar o remoto. Esta tabela classifica
  pelo efeito em **montar**, e sem acesso não há nem o primeiro clone.

### Quem faz o quê

| Etapa | Quem executa | Por que a tarefa exige esse executor |
|---|---|---|
| Instalar Docker, habilitar WSL2, instalar Git e Node | **uma pessoa na máquina** | Instalador gráfico, elevação de privilégio, aceite de licença e reinício — nada disso se conclui por linha de comando não interativa |
| Preparar a credencial de acesso — chave SSH registrada na conta, ou token para o `credential.helper` | **uma pessoa na máquina** | Registrar chave ou emitir token exige autenticar num serviço externo, com a conta de quem vai trabalhar. Token é segredo, e valor de segredo não passa por agente |
| Conceder acesso ao repositório | **quem administra o repositório** | Não é executável nem na máquina nem pelo agente: é decisão de outra pessoa. Sendo você essa pessoa, resolve-se sozinho; não sendo, **peça antes de começar** |
| Fornecer a chave da OpenAI | **uma pessoa na máquina** | É segredo, e valor de segredo não passa por agente nem por artefato versionado |
| Todo o resto | **o agente** | Clonar, configurar os dois repositórios, criar o `.env`, verificar pré-requisitos, construir, migrar, subir, validar e diagnosticar |

A coluna do meio descreve **a propriedade da tarefa**, não a capacidade de um
agente em particular. Uma tarefa que hoje exige uma pessoa por causa de
instalador gráfico continuará exigindo; uma que deixe de exigir muda de linha
por mérito próprio — não porque o agente ficou melhor.

### Etapa 1 — o que exige uma pessoa

Cada item abaixo tem o **teste objetivo** e a **ação** declarados no
[`MANIFESTO.yaml`](MANIFESTO.yaml), que é a fonte deles. Não são repetidos aqui,
porque uma segunda cópia envelheceria em silêncio — **com uma exceção declarada**,
o item 4: o teste dele é o único que precisa rodar antes de existir clone, e por
isso aparece aqui em forma executável. A regra de propagação dessa cópia está na
matriz da skill `oratia-ambiente`.

1. **Docker em execução, com backend WSL2 no Windows** — itens `docker-engine`,
   `docker-compose` e `docker-backend-wsl2`.
2. **Git** — item `git`.
3. **Node 18+**, para o ferramental — item `node-ferramental`.
4. **Acesso ao repositório** — item `acesso-ao-remoto`. Por SSH ou por HTTPS: o
   método é escolha sua, e a etapa 2 trata do que cada um exige. O verificador
   só chega dentro do clone, mas **o teste deste item não depende dele** e roda
   fora de qualquer repositório — basta trocar `origin` pela URL:

   ```bash
   git ls-remote --exit-code git@github.com:gladsjr/super-ta.git HEAD
   ```

   Responde `0` e imprime uma linha com o hash de `HEAD`. Use a URL do **seu**
   método. É o único teste da etapa 1 que se roda antes de existir clone, e é o
   que você quer rodar primeiro: falhando aqui, o clone da etapa 3 falha igual.
5. **Opcionalmente, a chave da OpenAI** — item `token-openai`. Como fornecê-la
   sem que ela vire arquivo em disco está comentado no
   [`.env.example`](.env.example).

Depois de existir um clone, o verificador confere de uma vez **todos** os itens
acima — a chave da OpenAI inclusive, que aparece como AVISO —, mais três que
esta lista não menciona porque não dependem de você (`clone-do-tronco`,
`arquivo-env` e `porta-app`):

```bash
node tools/verificar-prerequisitos.mjs
```

### Etapa 2 — Acesso ao repositório e identidade de commit

Vem **antes** do clone de propósito: os comandos da etapa 3 falham sem acesso, e
podem autenticar pela conta errada se a credencial errada for oferecida.

**Escolha primeiro o método, porque ele determina a URL do clone.** O Git aceita
mais de um, e qual você usa é decisão sua — o roteiro não presume nenhum:

| Método | URL de clone | O que precisa estar pronto |
|---|---|---|
| **SSH** | `git@github.com:…` (ou `git@seu-alias:…`) | Chave registrada na sua conta |
| **HTTPS** | `https://github.com/…` | Credencial guardada pelo `credential.helper`, ou um token a fornecer no primeiro acesso |

Os dois foram verificados neste workspace: `git ls-remote` responde por SSH e por
HTTPS. **Qual helper a sua máquina usa é outra questão** — na que serviu de
referência é o `manager`, que vem com o Git for Windows e resolve o HTTPS sem
nada a digitar depois do primeiro acesso; em macOS e Linux o padrão é outro.
Confira o seu na subseção de HTTPS, abaixo.

> **Token nunca na URL do remote.** `https://usuario:token@github.com/…`
> funciona e é a pior forma possível: o token fica no `.git/config`, aparece em
> `git remote -v`, vaza em log e captura de tela, e trocá-lo não revoga o antigo.
> Deixe o `credential.helper` guardá-lo. Encontrando um remote assim,
> **pare e avise quem administra o repositório** — é segredo exposto.
>
> E note o que "usuário e senha" significa no GitHub.com: usuário mais **token**
> no lugar da senha — a senha da conta não é aceita para operações de Git. Isto é
> política de um serviço de terceiro, **não verificada por comando local** e
> sujeita a mudar; confirme na documentação dele, e note que num remote que não
> seja GitHub.com a regra pode ser outra.

#### Por SSH: fixar a chave certa havendo várias

Aplica-se **só** a quem escolheu SSH e mantém mais de uma chave. Sem isso o
cliente SSH pode oferecer outra e autenticar com a conta errada:

```bash
git config core.sshCommand "ssh -o IdentitiesOnly=yes -i ~/.ssh/sua_chave"
```

Quando a chave está carregada no agent do sistema em vez de legível em disco,
aponte para o arquivo público correspondente (`~/.ssh/sua_chave.pub`).

Há uma tensão real aqui, e é melhor declará-la: o comando acima roda **dentro**
de um repositório, e antes do primeiro clone não existe repositório onde rodá-lo.
A saída **não** é usar configuração global — isso ofereceria a chave deste
trabalho a todo repositório da máquina, o oposto do que o parágrafo anterior
pede. É usar o outro mecanismo, de escopo por host: `IdentitiesOnly` e
`IdentityFile` numa entrada `Host` do `~/.ssh/config`, que vale antes de existir
clone algum.

A entrada tem esta forma — os cinco campos são os que este workspace usa; o
nome do alias é livre:

```
Host oratia-remoto
    HostName github.com
    User git
    IdentityFile ~/.ssh/sua_chave
    IdentitiesOnly yes
```

**O alias tem uma consequência que precisa estar clara:** ele vale só para
remotes que o usem, então o clone da etapa 3 passa a ser
`git@oratia-remoto:gladsjr/super-ta.git` em vez de `git@github.com:…`. Escrever
`Host github.com` dispensaria isso, mas passaria a valer para **todo**
repositório do GitHub na máquina — de volta ao problema que o alias existe para
evitar.

São esses **dois** mecanismos para SSH, e só eles. Qual escopo cada um cobre, e
o que cada um **não** cobre, está na tabela de divergências da skill
`oratia-conhecimento` — que é também onde se **diagnostica** chave trocada. A
prescrição é esta seção.

**Um agente não edita arquivo fora da pasta do workspace** — nem este, nem
nenhum outro. A regra é geral e vem da fronteira do compartimento no
[`CLAUDE.md`](CLAUDE.md): o que está fora é compartilhado com todo outro
contexto desta máquina. Aplicada aqui: o agente **descreve** o bloco, e quem o
escreve é você.

#### Por HTTPS: nada a fazer antes do clone

O `credential.helper` cuida disso no primeiro acesso — pedindo o token, ou
abrindo o fluxo de autenticação, conforme o helper instalado. Confira qual está
em vigor:

```bash
git config --get credential.helper
```

Vazio nos três escopos (repo, global e system) significa que cada operação vai
pedir a credencial de novo. Isso é decisão de configuração da máquina, não deste
workspace.

> **Autentique uma vez antes de rodar o verificador.** Sem credencial guardada,
> o teste do item `acesso-ao-remoto` **pendura**: helpers gráficos abrem diálogo,
> e o verificador espera. Quem o solta é o limite de 30 s dele, e o corte
> respeita o prazo mesmo com um processo **neto destacado** ainda vivo,
> segurando a saída — que era o caso em dúvida, já que o filho é quem recebe o
> sinal. Medido com um substituto do diálogo; ver a skill. Depois disso ele reporta AVISO e segue. Rodar um `git ls-remote` da sua URL num terminal interativo resolve de
> uma vez — o helper guarda a credencial e o teste passa a responder em menos de
> um segundo. A medição está na skill `oratia-conhecimento`.

#### A identidade de commit, em qualquer método

Configure **em cada um dos dois repositórios**, com configuração local e não
global — sobretudo se a máquina hospedar trabalho de mais de uma organização,
porque cada commit carrega o e-mail configurado:

```bash
git config user.name "Seu Nome"
git config user.email "seu.email@organizacao"
```

Estes dois também rodam dentro de um repositório, então na ordem real vêm
**depois** do clone. Não há como antecipá-los, e não é preciso: o que precisa
estar certo antes do clone é a credencial, não a identidade.

### Etapa 3 — Obter os dois repositórios

Use a URL do **método que você escolheu na etapa 2**. Por SSH sem alias:

```bash
git clone --branch oratia-sdlc --single-branch git@github.com:gladsjr/super-ta.git oratia
cd oratia
git clone git@github.com:gladsjr/super-ta.git super-ta
```

Por HTTPS, as mesmas duas linhas com `https://github.com/gladsjr/super-ta.git`;
por SSH com alias, com `git@seu-alias:gladsjr/super-ta.git`. O que **não** muda
em nenhum caso: `--single-branch` no primeiro (a história do tronco não vem, já
que este branch é órfão), e o nome `super-ta` no segundo — é assim que o
`.gitignore` o exclui, e com outro nome o clone inteiro entraria no índice do
workspace.

Falhando, o erro diz qual é o caso, e as causas **não** são a mesma:

| Mensagem | O que falta |
|---|---|
| `Permission denied (publickey)` | Por SSH: **ou** a chave não está registrada na conta e o acesso concedido (item `acesso-ao-remoto`), **ou** o cliente ofereceu a chave errada tendo várias (etapa 2). As duas produzem esta mensagem — não conclua a primeira sem descartar a segunda |
| `could not read Username` / `Authentication failed` | Por HTTPS: o `credential.helper` não tinha credencial guardada e não houve como pedi-la. Rode um `git ls-remote` da URL num terminal interativo para fornecê-la, e então repita o clone |
| `Repository not found` autenticando bem | O acesso não foi concedido a esta conta, ou você autenticou por outra — item `acesso-ao-remoto`, e ver *Quem faz o quê* |

### Etapa 4 — daqui o agente conduz sozinho

Nada mais nesta montagem exige uma pessoa. O procedimento, com verificação a
cada passo e tabela de diagnóstico sintoma → passo → causa, é o
[`INSTALACAO.md`](INSTALACAO.md), que é a fonte — **do passo 2 ao passo 9**. Em
ordem: criar o `.env`, conferir os pré-requisitos, construir a imagem, subir o
banco, instalar as dependências no volume, aplicar as migrations, subir a
aplicação e validar que ela responde de verdade.

**A montagem para no passo 9, e isso é decisão registrada, não esquecimento.**
O passo 10 valida a jornada com IA e **consome créditos da API** — alguns
centavos por execução. Montar o ambiente não deve custar dinheiro, e é por isso
que a ordem canônica em `bootstrap:` no [`MANIFESTO.yaml`](MANIFESTO.yaml)
termina em 9, com o ambiente de pé. Rode o passo 10 quando quiser validar a
camada cognitiva, com autorização de quem paga a conta — e note que ele exige a
chave da OpenAI, opcional na etapa 1: na máquina sem chave, a ausência do passo
10 **não** é falha de montagem.

A skill **`oratia-deploy`** conduz e diagnostica; a **`oratia-build`** cobre
imagem, dependências e migrations. Havendo um agente, basta:

```
sobe o oratia localmente
```

### Quando o agente trava

Um agente que encontre um bloqueio da etapa 1 **não deve contornar**. A conduta
é esta, e ela vale mais que concluir a montagem:

1. **Nomear o bloqueio** pelo `id` do item no `MANIFESTO.yaml` — não pela
   posição na lista acima, cujo primeiro tópico agrupa três `id`s.
2. **Dar o teste objetivo** que comprova a conclusão, tirado do `teste:` do
   item, para que ela saiba quando terminou. Sendo o item `acesso-ao-remoto`, o
   teste é o mesmo `teste:` com a URL no lugar de `origin`, e roda antes de
   existir clone — não devolva esse item sem ele.
3. **Devolver à pessoa e parar.** Sendo o item o acesso ao repositório, dizer
   também que pode não estar nas mãos dela — ver *Quem faz o quê*.
4. **Não inventar contorno.** Instalar por gerenciador de pacotes o que o
   manifesto manda instalar pelo instalador oficial, desabilitar a verificação
   de host do SSH, ou escrever segredo em arquivo versionado são todos piores
   que parar.

### O ambiente está pronto quando

Não há checklist próprio aqui, de propósito. O critério é o
`validacao_funcional:` do [`MANIFESTO.yaml`](MANIFESTO.yaml) — cada item com seu
`comando` e seu `esperado`, e a marca de quais exigem a chave da OpenAI — mais
`node tools/verificar-prerequisitos.mjs` sem bloqueios. A skill `oratia-deploy`
traz a mesma sequência na ordem de execução, com o que fazer quando cada uma
falha.

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

## Prompt para delegar a montagem ao agente

Cole o texto abaixo numa sessão de agente na pasta onde você quer o workspace.
Ele foi escrito para funcionar **antes de o workspace existir** — é por isso que
carrega a URL e a fronteira do compartimento dentro de si, em vez de remeter a
arquivos que ainda não estão na máquina.

Antes de colar, tenha concluído os itens da **etapa 1** marcados **sim** na
coluna *Para montar*: Docker de pé (no Windows com WSL2), Git, e **acesso ao
repositório funcionando pelo método que você usa** — o que inclui, se for o
caso, ter fixado qual chave SSH usar (etapa 2). Confirme o último com o teste
pré-clone da etapa 1: um `git ls-remote --exit-code <sua URL> HEAD` que responda
`0`. O agente vai parar e devolver a você qualquer um que falte.

Os outros dois itens da etapa 1 não travam a montagem, mas cobram atrito: sem
**Node 18+** o passo 3 do roteiro não roda — o agente segue sem ele, como o
próprio [`INSTALACAO.md`](INSTALACAO.md) explica; e sem a **chave da OpenAI** o
ambiente sobe igual, só sem a camada cognitiva.

````text
Monte o workspace de SDLC do ORATIA nesta pasta e suba o ambiente local.

REGRA QUE VALE ACIMA DA TAREFA — compartimento estanque. Esta máquina pode
hospedar trabalho de outras organizações e clientes. Trabalhe apenas dentro da
pasta que você vai criar. Não varra o disco procurando contexto, clone, chave ou
configuração existentes. Não traga para este trabalho nome de cliente, empresa,
produto, repositório ou ferramenta de outro contexto, nem a menção de que
existem. Precisando de algo fora da pasta, vá ao caminho específico e diga
qual. E justifique toda decisão pelos fatos daqui: "vi funcionar em outro
lugar" não é evidência, e sem base local suficiente diga isso e me pergunte,
em vez de decidir por analogia. Esta é a versão condensada de uma regra que
está inteira no CLAUDE.md do repositório: assim que ele existir, ele é que
vale.

1. Antes de clonar, me confirme a URL do repositório. O padrão é
   git@github.com:gladsjr/super-ta.git (SSH). Se eu uso HTTPS, é
   https://github.com/gladsjr/super-ta.git; se eu uso um alias SSH próprio,
   te passo a URL com o alias. NÃO adivinhe: pergunte, porque a URL errada
   autentica pela conta errada ou nem autentica.

2. Com a URL confirmada, clone os dois repositórios — <URL> é a que eu passei:

   git clone --branch oratia-sdlc --single-branch <URL> oratia
   cd oratia
   git clone <URL> super-ta

   Falhando, NÃO conclua a causa: "Permission denied (publickey)" tem duas
   (acesso não concedido, ou chave errada oferecida tendo várias), e por HTTPS
   a falha é de credencial, não de acesso. Me diga a mensagem exata e pare.
   Não edite o ~/.ssh/config nem nenhum arquivo fora da pasta do workspace.

3. PARE e me peça para reabrir a sessão na raiz do workspace (a pasta `oratia`
   que você acabou de criar). É lá que o CLAUDE.md, o PRIMER.md e as skills são
   descobertos, e reabrir garante que você os tenha antes de prosseguir. Não
   prossiga sem isso.

4. Reaberta a sessão, leia o README.md e execute a seção "Montar o ambiente" a
   partir da etapa 2. Me pergunte nome e e-mail para a identidade de commit dos
   dois repositórios; me avise se eu precisar fixar chave SSH por ter várias.

5. Siga o INSTALACAO.md do passo 2 ao 9, e PARE ali. NÃO rode o passo 10: ele
   consome créditos da API, e montar o ambiente não deve custar dinheiro. Ao
   terminar o 9, me diga que o passo 10 está disponível e espere eu autorizar.
   Bloqueio da etapa 1 do README: aplique a conduta de "Quando o agente trava"
   — nomeie o item pelo id do manifesto, dê o teste objetivo, devolva a mim e
   pare. Não contorne.

6. Ao terminar, me diga o que está no ar, o que ficou indisponível e por quê.
````

**Por que o prompt para no passo 3.** As skills e o steering deste branch são
descobertos quando a sessão é aberta na raiz do workspace, e no momento em que
você cola o prompt essa pasta ainda não existe. O que acontece com uma sessão já
aberta quando a pasta passa a existir no meio dela **não foi verificado** —
reabrir contorna a questão em vez de depender dela.

**Se você não tem agente à mão**, as mesmas etapas rodam à mão: *Montar o
ambiente* aqui, e [`INSTALACAO.md`](INSTALACAO.md) do passo 2 ao 9.

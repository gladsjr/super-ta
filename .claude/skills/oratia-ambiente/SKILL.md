---
name: oratia-ambiente
description: >-
  Monta o ambiente do ORATIA numa máquina nova e diagnostica falhas de
  ambiente. Cobre pré-requisitos, Docker sobre WSL2 no Windows, o clone do
  tronco, volumes, portas e a matriz de propagação dos fatos que aparecem em
  mais de um arquivo. Use quando o pedido for preparar, montar, configurar ou
  consertar o AMBIENTE — frases como "montar o oratia em outra máquina",
  "configurar o ambiente do zero", "o verificador acusa bloqueio", "o container
  não sobe", "porta ocupada", "o banco sumiu", "onde mudo essa configuração",
  "posso renomear a pasta". NÃO use para construir imagem ou aplicar migrations
  (use oratia-build), para subir e validar a aplicação (use oratia-deploy) nem
  para evoluir o código (use oratia-improve).
---

# Ambiente do ORATIA

Tudo roda em containers. No Windows, Docker **sempre** sobre WSL2. A máquina do
colaborador não precisa de Node, ffmpeg, Python nem Postgres para a aplicação
funcionar — a imagem traz tudo. O Node do host serve só ao verificador.

## Antes de qualquer diagnóstico

```bash
node tools/verificar-prerequisitos.mjs
```

Executa a lista do `MANIFESTO.yaml` e diz o que falta e como resolver. Sai com
código diferente de zero havendo bloqueio. **Comece sempre por aqui** — ele
responde a maioria das perguntas de ambiente sem investigação.

Montagem do zero: siga o `INSTALACAO.md`, que tem os dez passos na ordem de
dependência, cada um com sua verificação — mas **a montagem termina no passo 9**.
O passo 10 consome créditos de API e só se roda com autorização de quem paga a
conta; o porquê está no `README.md`, na etapa que remete ao roteiro.

**Antes dele, o `README.md`, seção *Montar o ambiente*.** É lá que está o que o
roteiro não tem: quais etapas exigem uma pessoa e por quê, quais dependem de
quem administra o repositório, e a conduta quando o agente trava — nomear o
item, dar o teste objetivo, devolver e parar, em vez de contornar. Montando por
pedido de um colaborador novo, comece por ali.

## Princípio que decide os casos duvidosos

> Nenhum artefato presume a identidade da máquina, do colaborador ou do agente.

Diante de uma escolha de ambiente, prefira o que funciona igual em Windows,
macOS e Linux, para alguém que acabou de clonar o repositório. O que varia por
pessoa vive em arquivo ignorado pelo git (`.env`), com default que funciona
sozinho.

Corolário prático: o `AGENTS.md` do tronco tem uma tabela alocando clone, banco
e porta entre agentes nomeados. Aquilo descreve **uma** máquina. A *regra* de
isolamento é válida e vale sempre; a *tabela* não é fonte para este workspace.

## Coisas que parecem detalhe e não são

**O nome da pasta do clone é `super-ta`, e não é negociável.** É por esse nome
que o `.gitignore` desta branch o exclui e que o `docker-compose.yml` o monta.
Renomear faz o clone inteiro entrar no índice do workspace.

**O nome do projeto Compose está fixo em `super-ta`.** Sem `name:`, o Compose
deriva o nome do projeto do nome da PASTA — e o nome da pasta do workspace é
livre. O volume do banco viraria `<pasta>_superta-pgdata`, diferente para cada
colaborador. Verificado: da raiz do workspace sairia `oratia_superta-pgdata`;
de dentro do clone, `super-ta_superta-pgdata`. Fixando o nome, os dois caminhos
convergem no mesmo volume. **Mudar o `name:` órfã o banco existente.**

**Dois workspaces na mesma máquina compartilham containers e volumes.** É a
outra face do `name:` fixo, e foi verificada: um segundo workspace, montado do
zero em outra pasta, reusou o banco já migrado pelo primeiro. Consequências:

- **Não dá para rodar dois ambientes ORATIA ao mesmo tempo** — o
  `container_name: superta-db` colide, e a porta publicada também.
- Em compensação, montar um segundo workspace é barato: banco e dependências já
  estão lá.
- Precisando mesmo de dois ambientes simultâneos, é decisão do usuário: exigiria
  `name:` distinto **e** portas distintas, e cada um teria seu próprio banco.

**`node_modules` mora num volume, nunca no bind mount.** Duas razões
independentes, ambas medidas nesta máquina:

- *Plataforma.* `bcrypt` e `onnxruntime-node` são binários nativos; os que o
  host compila não carregam no Linux do container.
- *Velocidade.* Escrita no bind mount é **77x mais lenta** que no filesystem do
  container (583 contra 45.145 arquivos por segundo, atravessando a fronteira
  Windows↔WSL2).

**A porta padrão é 5099, e não a 5000 do código.** No macOS a 5000 é ocupada
pelo AirPlay Receiver. Como o ambiente precisa subir igual nos três sistemas, o
default do workspace se afasta do default do código de propósito.

## Diagnóstico

O `INSTALACAO.md` tem a tabela completa de sintoma → passo → causa. Os casos
que mais confundem:

**O verificador trava perto do fim, ou abre um diálogo.** É o item
`acesso-ao-remoto`, o único `teste:` que sai da máquina, esperando credencial de
um remote HTTPS. Sintoma, causa, correção e tempos medidos na skill
`oratia-conhecimento`.

**Verificador diz "porta livre" mas o `up` falha.** Não deve mais acontecer, e
vale saber por quê: no Windows com Docker Desktop, o `bind` numa porta já
publicada **sucede** — em `127.0.0.1` e em `0.0.0.0`. O idioma comum de checar
porta por `listen`/`EADDRINUSE` dá falso negativo aqui. O verificador testa
conexão primeiro, e só depois bind.

**`Cannot find module '/app/C:/Program Files/Git/...'`.** Git Bash no Windows
converte caminhos absolutos estilo Unix em caminhos Windows ao repassá-los a
executáveis. Prefixe com `MSYS_NO_PATHCONV=1`.

**Módulo nativo não carrega.** O volume de `node_modules` foi populado a partir
do host. `docker compose down -v` e refaça a partir do passo 5 do roteiro.

**O banco "sumiu" depois de mexer no compose.** Provavelmente o `name:` mudou,
ou o compose foi rodado de outro diretório. Confira os volumes:

```bash
docker volume ls --filter name=pgdata
```

Havendo mais de um `*_superta-pgdata`, os dados estão no outro. Não apague nada
sem falar com o usuário — o volume órfão pode ter o único banco com dados.

## Matriz de propagação

Fatos que aparecem em mais de um lugar. **A fonte manda; os demais acompanham.**
Duplicata sem regra de propagação diverge em silêncio.

| Fato | Fonte da verdade | Também aparece em | Regra |
|---|---|---|---|
| Lista de pré-requisitos | `MANIFESTO.yaml` (`prerequisitos:`) | `README.md` (tabela *O que precisa existir*) e `INSTALACAO.md` (*Antes de começar*) — os dois **resumem** a lista. A exceção é o `teste:` de `acesso-ao-remoto`, que os dois trazem literal de propósito — no `INSTALACAO.md` em *Antes de começar*, e no README **não** na tabela e sim no item 4 da *Etapa 1* —, pela razão registrada na linha própria dele: é o único item cujo teste precisa rodar **antes** do clone | O verificador **não tem lista própria**: é só executor. Nunca acrescente **checagem** no script; acrescente no manifesto. Consertar **como** o executor roda (a cwd fixa na raiz, por exemplo) não é acrescentar checagem, e é do script. Item novo entra no manifesto e nos dois resumos. A coluna *Para montar* do README traduz o `nivel:`: `bloqueio` → **sim**; `aviso` que degrada o ferramental → *recomendado*; `aviso` que indisponibiliza capacidade do produto → *opcional*. `acesso-ao-remoto` é a exceção declarada — `aviso` no manifesto, que classifica o ambiente já montado, e **sim** no README, que classifica montar. |
| Definição do banco (imagem, credenciais, healthcheck) | `super-ta/docker-compose.yml` | `docker-compose.yml` do workspace, por `include` | Nunca copie o serviço `db` para cá. Mudou lá, chega aqui sozinho — exceto a `DATABASE_URL`, que é montada em `x-ambiente-app` e precisa de ajuste manual se usuário, senha ou nome do banco mudarem. |
| Versão do Node | `super-ta/.replit` (`modules = nodejs-20`) | `Dockerfile` (`FROM node:20-…`), `MANIFESTO.yaml` | O tronco manda. Mudou lá, atualize o Dockerfile e reconstrua a imagem. |
| Nome da pasta do clone (`super-ta`) | `.gitignore` desta branch | `docker-compose.yml` (bind mount e `include`), `MANIFESTO.yaml`, `INSTALACAO.md` | Não mude. Precisando mudar, os quatro mudam na mesma alteração. |
| Nome do projeto Compose (`super-ta`) | `docker-compose.yml` (`name:`) | Nomes de volume citados no `INSTALACAO.md` e nesta skill | Mudar renomeia todos os volumes e órfã o banco. Trate como imutável. |
| Porta da aplicação | `.env` (`ORATIA_APP_PORT`), default 5099 | `docker-compose.yml`, `MANIFESTO.yaml`, `INSTALACAO.md`, `oratia-deploy` | Mudando o **default**, atualize os quatro. Mudança pessoal fica só no `.env`. |
| Rota de saúde (`/oral/ping`) | `super-ta/routes/oralExam.js` | `docker-compose.yml` (healthcheck de `app` e de `pack`), `MANIFESTO.yaml`, `INSTALACAO.md` | Se o tronco mudar a rota, os healthchecks passam a reprovar. Atualize os quatro. |
| Nome do segredo da OpenAI | Código do tronco: `OPENAI_API_KEY` | `docker-compose.yml` faz a ponte de `ORATIA_OPENAI_TOKEN`; `.env.example` e `MANIFESTO.yaml` documentam | O colaborador só conhece `ORATIA_OPENAI_TOKEN`. Mudando o nome no tronco, corrija a ponte no compose. |
| Usuários semeados | `.env` (`INITIAL_USERS`) | `MANIFESTO.yaml`, `INSTALACAO.md`, `oratia-deploy` e **`tools/validar-jornada-ia.mjs`** (que faz login de verdade) | Mudando o default, atualize os quatro — inclusive o aviso de que o admin global é o **primeiro** da lista. O validador aceita `JORNADA_USER`/`JORNADA_PASS` para não depender do default, mas o default dele tem de acompanhar. |
| Qual branch para cada ciclo | `PRIMER.md` | `CLAUDE.md` (ponteiro), `oratia-revisor` (critério de reprovação), `README.md` | O primer manda. Mudou lá, os três acompanham. |
| O que exige revisão e o que é isento | `PRIMER.md` | `oratia-revisao` | O primer manda. A lista de isenções é **fechada**: ampliá-la é mudança de conduta, não ajuste de skill. O `oratia-revisor` **não** carrega esta lista — ele julga o que lhe é submetido, não decide o que deveria ter sido. |
| Gatilhos de propagação produto → SDLC | `PRIMER.md` (tabela) | `oratia-revisor` **por referência** — não copie a tabela para lá | Acrescentar gatilho é editar só o primer. Uma cópia no revisor ficaria incompleta em silêncio, que foi como esta entrega errou na primeira rodada. |
| Ferramentas do revisor (só leitura) | frontmatter de `.claude/agents/oratia-revisor.md` | `PRIMER.md`, `oratia-revisao`, `MANIFESTO.yaml`, `README.md` | O frontmatter é o que vale: é ele que a plataforma aplica. Mudou a lista de ferramentas, os quatro textos acompanham — ou passam a mentir sobre uma garantia de segurança. |
| O que quem submete precisa declarar | `oratia-revisao` | `oratia-revisor` (que grau cada ausência rende) | A skill descreve o que enviar; o agente descreve como reagir à falta. Mudou um, confira o outro. |
| Graus BAIXO / MODERADO / CRÍTICO e o que reprova | `PRIMER.md` | `oratia-revisao`, `oratia-revisor` | Repetido nos três de propósito: o revisor precisa ser autossuficiente para aplicar sem depender de leitura em tempo de execução. Mudou o critério, os três mudam na mesma alteração. |
| Teto do laço de reformulação (3 rodadas) | `PRIMER.md` | `oratia-revisao` | O primer manda. A skill acrescenta a cláusula de reincidência, que escala antes do teto — isso é dela, não duplicata. |
| Base normativa (a lista de fontes) | `PRIMER.md` | `oratia-revisor` | Fonte nova entra nos dois. Nunca acrescente fonte só no agente. |
| Intervalo de verificação (24h) e conduta do hook | `tools/verificar-atualizacao-sdlc.mjs` | `PRIMER.md` | O script é a fonte: é ele que decide o que fazer e quando. O primer descreve em prosa. |
| **Orçamento de tempo do hook** — invariante numérico | `.claude/settings.json` (`timeout`, hoje 45) **limita** `tools/verificar-atualizacao-sdlc.mjs` (`DEADLINE_TOTAL_MS`, hoje 25s) | — | Direção INVERSA às outras linhas: o timeout do hook é limite superior, porque estourá-lo mata o processo antes de o aviso sair. **Invariante: `timeout` × 1000 ≥ `DEADLINE_TOTAL_MS` + `FOLGA_PISO_MS`** (hoje 45.000 ≥ 25.000 + 10.000). A folga não é decorativa: esgotado o deadline, cada chamada git restante ainda consome o piso de 1s, então `DEADLINE < timeout` sozinho **não** basta. Baixando o timeout, baixe o deadline junto; nenhum dos dois arquivos valida isso sozinho. |
| Estado de cada frente do roadmap (aberta, parcial, entregue) | roadmap na skill `oratia-improve` | `METAS.md`, em **três** lugares: as metas que citam frentes, a seção *Alcançadas* e a lista de *Candidatas* | O roadmap manda. Entregando ou abandonando uma frente, atualize-o e percorra os três: uma meta pode ter sido alcançada, uma candidata pode ter deixado de fazer sentido. Foi por não percorrer todos que a primeira versão nasceu divergindo. |
| Riscos abertos de escala e segurança, com estado verificado | skill `oratia-improve`, seção *Riscos abertos* | os outros **três** dos quatro lugares que a própria seção enumera, na mesma ordem: *Débitos conhecidos* (mesmo arquivo), `docs/analise-arquitetural.md` (análise narrativa, com severidade e diagramas) e `METAS.md` (nas metas que citam risco — a correspondência está na tabela risco → meta da própria seção, não aqui) | A skill manda no **estado**. Mudando o estado de um risco, **percorra os quatro** — a enumeração canônica é a da própria seção *Riscos abertos*; esta linha não mantém lista paralela. O `analise-arquitetural.md` envelhece: achando nele afirmação vencida, **corrija-a** e marque onde deixou de valer — e corrija **todas** as ocorrências do fato, não a primeira que aparecer. **Nada disso é backlog priorizado**: esse vive nas issues do tronco. |
| Como fixar a chave SSH certa havendo várias | `README.md`, seção *Acesso ao repositório e identidade de commit*, subseção *Por SSH: fixar a chave certa havendo várias* (a **prescrição**) — citada **sem** ordinal de propósito, para sobreviver a renumeração das etapas | `oratia-conhecimento` traz só o **diagnóstico** e remete ao README, citando o nome **uma** vez (a linha da tabela de divergências foi tachada e não o cita mais). O nome aparece ainda em `INSTALACAO.md` (tabela de diagnóstico) e `MANIFESTO.yaml` (a `acao:` de `acesso-ao-remoto`): **quatro** citações ao todo, contando a desta linha, mais o cabeçalho no próprio README | Renomeando a seção, grepe pelo nome antigo **inteiro** e confira as quatro. Escreva cada citação com o nome numa **linha só**: um nome quebrado por mudança de linha não é encontrado por grep, e foi assim que esta contagem já ficou errada uma vez — foi confiar na memória que já quebrou um ponteiro nesta entrega. O README manda no que fazer; a skill, em como descobrir o que está acontecendo. Não mova a prescrição para a skill: existem **dois mecanismos, de escopos diferentes** (`core.sshCommand` com `-i`, ou `IdentitiesOnly`/`IdentityFile` no `~/.ssh/config`) — a comparação e o que cada um NÃO cobre estão na tabela de divergências da `oratia-conhecimento`, não aqui. Ter duas receitas sem dono foi o que a revisão pegou. |
| Ferramental do workspace montado no container (`/ferramental`) | `docker-compose.yml` (o bind em `x-codigo-montado`) | `MANIFESTO.yaml` (layout de `tools`), `INSTALACAO.md` (passo 10), `oratia-deploy`, cabeçalho de `tools/validar-jornada-ia.mjs` | O compose manda. Mudando o ponto de montagem, os quatro acompanham. Note que o anchor alcança `deps`, `migrate` e `app` — e **não** `pack`, de propósito: `pack` existe para provar que a aplicação sobe sem bind mount algum. |
| Porta **interna** da aplicação (5099) | `docker-compose.yml` (`PORT` em `x-ambiente-app`) | os dois healthchecks do compose (`app` e `pack`) e o `BASE` de `tools/validar-jornada-ia.mjs` | Não confunda com a linha acima: o que `MANIFESTO.yaml`, `INSTALACAO.md` e `oratia-deploy` citam (`curl localhost:5099`) é a porta **publicada no host**, que varia por colaborador. Mudando a interna, são estes três que acompanham — e é fácil esquecer os healthchecks. |
| **Critério de aprovação da jornada com IA** | `tools/validar-jornada-ia.mjs` — a conjunção em `const ok = …` é o árbitro | `MANIFESTO.yaml` (`esperado:`), `INSTALACAO.md` (passo 10), `oratia-deploy` | O **código** manda: os três textos descrevem o que ele conjuga. Mexendo no `ok`, **conte as condições** e propague o número junto — esta duplicata já divergiu duas vezes: uma com o critério antigo sobrevivendo em dois dos três, outra com "quatro coisas" onde o código conjuga cinco. Note também que o **número de falas** do validador está acoplado ao piso de finalização do tronco (`⌈perguntas do plano / 2⌉`, `routes/interview.js`): poucas falas não alcançam `interviewing`, e o encerramento antes da última é tratado como legítimo, não como falha. |
| Layout do workspace (a árvore de pastas) | `MANIFESTO.yaml` (`layout:`) | `README.md` (árvore ilustrativa), `CLAUDE.md` (mapa curto) | **Nenhum dos três é exaustivo**, e não tente fazê-los ser: o manifesto lista o que importa para montar e diagnosticar (com a `origem` de cada caminho), não todo arquivo do repositório. Acrescentando **pasta** nova, ou arquivo cuja `origem` seja `gerada`, `volume` ou `local`, ela entra no `layout:` — é ali que se diz o que é descartável e o que não se recupera. Arquivo versionado novo não precisa de entrada própria. |
| Carregamento diferido de subagente e de hook | `.claude/skills/oratia-conhecimento/SKILL.md` (a armadilha) | `PRIMER.md` (a consequência para releitura), `tools/verificar-atualizacao-sdlc.mjs` (a regex `.claude/(agents\|settings.json)` e a mensagem), `README.md` (o prompt colável, que afirma que reabrir a sessão na raiz garante steering e skills) | Mudando o que a plataforma carrega quando, os quatro mudam juntos. A regex do script é o que decide **quando o aviso aparece**; a skill é o que explica **por quê**. |
| Destruição de acentuação ao enviar dado pela linha de comando no Windows — **dois** problemas distintos: o `curl` do Git Bash e o charset do `Invoke-RestMethod` | `.claude/skills/oratia-conhecimento/SKILL.md` (a armadilha, com os bytes medidos) | `INSTALACAO.md` e `oratia-deploy`, ambos **só** na linha de diagnóstico pelo sintoma | A skill de conhecimento traz a medição e o porquê; as duas tabelas trazem sintoma e as duas correções, uma por cliente. Mudando qualquer das correções, as três mudam. Nunca copie a tabela de bytes para as tabelas de diagnóstico, e nunca reduza os dois problemas a um só — foi assim que a primeira redação errou. |
| Endereço do repositório (`owner/repo`) no roteiro | `README.md` — a *Etapa 3*, o roteiro de clone, com **duas** ocorrências (uma por repositório) | `README.md` em mais seis pontos, porque o roteiro deixou de presumir um método: o **teste pré-clone** da *Etapa 1*, o exemplo de alias na *Etapa 2*, as formas HTTPS e por alias citadas na própria *Etapa 3*, e as **duas** do **prompt colável** (que precisa da URL literal, por ser colado antes de o repositório existir). São **oito** ao todo, em quatro formas: `git@github.com:` (4), `https://github.com/` (2), `git@oratia-remoto:` (1, exemplo) e `git@seu-alias:` (1, ilustrativa). A tabela de métodos da *Etapa 2* traz as URLs **elididas**, sem `owner/repo`, e fica fora | Trocando `owner/repo`, **grepe por `gladsjr/super-ta`** e confira os oito — nunca grepe a URL inteira, que existe em quatro formas. Trocando só o **host**, apenas as seis que o nomeiam; as de alias são placeholder de propósito e não se "corrigem". A referência elidida na tabela de divergências da `oratia-conhecimento` não traz `owner/repo` e fica fora desta contagem. |
| Fronteira humano/agente na montagem, e a conduta quando o agente trava | `README.md`, seções *Quem faz o quê* e *Quando o agente trava* | esta skill, no corpo (*Montagem do zero*), **por remissão** — não copie as tabelas para cá | O README manda. A skill só garante que quem chega por "monta o oratia aqui" encontre a fronteira antes do roteiro. A coluna de razão do README descreve a **propriedade da tarefa**, nunca a capacidade de um agente: tarefa que deixe de exigir pessoa muda de linha por mérito próprio. |
| Onde a montagem termina, e por que o passo 10 fica fora | `INSTALACAO.md` (a nota destacada no passo 10: consome créditos, montar não deve custar dinheiro) e o `bootstrap:` do `MANIFESTO.yaml`, que termina em 9 | `README.md` em **quatro** lugares: a etapa 4, o parágrafo da decisão, o **passo 5** do prompt colável (era o 4 antes de o prompt ganhar a confirmação de URL — conte os passos, não confie neste número) e o rodapé; mais as **duas rotas de entrada por skill**, que são por onde um agente chega sem passar pelo README: esta skill (*Montagem do zero*) e `oratia-deploy` (*Máquina nova*) | Passando o passo 10 para dentro do bootstrap, ou mudando o número do último passo, mudam os **seis** pontos desta linha — os quatro do README e as duas rotas de skill, que dizem o número seco. Só o parágrafo da decisão atribui a fonte; os outros três dizem o número seco, e é por isso que esta linha existe. O critério é o **custo**, não a ordem: passo que gasta API fica fora da montagem. |
| Conduta: o agente não edita arquivo fora da pasta do workspace | `CLAUDE.md`, *Fronteira do compartimento* — a regra **geral** é a fonte, e é dela que a proibição deriva | `README.md` em dois lugares: a aplicação ao `~/.ssh/config` na *Etapa 2* e o imperativo no **prompt colável** | A geral manda. A do README é **aplicação a um caso**, não regra própria: estreitando a geral, a aplicação sobrevive; ampliando a aplicação, a geral não acompanha — foi essa assimetria que exigiu esta linha. Acrescentando outro arquivo de fora ao roteiro (um `~/.gitconfig`, por exemplo), a aplicação nova cita a geral em vez de reenunciá-la. |
| Falha de autenticação ao clonar: qual sintoma, qual causa | `README.md`, a tabela da *Etapa 3* — três sintomas, e o de `publickey` com as **duas** causas de SSH | `INSTALACAO.md` em dois lugares (as três linhas da tabela de diagnóstico, e a precondição do Passo 1) e `MANIFESTO.yaml` (a `acao:` de `clone-do-tronco`) — os dois últimos **em prosa**, que é onde uma causa se perde | Acrescentando sintoma, ou mudando a correção de um, os quatro pontos mudam. A regra que não pode cair em nenhum deles: `Permission denied (publickey)` **não distingue** acesso ausente de chave errada oferecida — nunca escreva uma das duas como se fosse a única. Foi exatamente esse o apontamento que reprovou uma rodada desta entrega. |
| O comando do `teste:` de `acesso-ao-remoto`, escrito literalmente | `MANIFESTO.yaml` (`teste:` do item) — é o único que o verificador executa | **Cinco** cópias literais, todas com a URL no lugar de `origin`, porque servem ao caso pré-clone: `README.md` (o teste da *Etapa 1* e o preâmbulo do prompt), `INSTALACAO.md` (*Antes de começar* e a linha do diálogo na tabela de diagnóstico) e `oratia-conhecimento` (a correção da armadilha) | Mudando o comando no manifesto — outro flag, outro `HEAD`, outro comando —, as cinco cópias mudam. **Elas existem de propósito**: o `teste:` do manifesto usa `origin` e só vale depois do clone; estas usam a URL e valem antes, que é justamente o momento em que o colaborador precisa. Não as apague em nome de "uma fonte só" — declare esta linha. |
| Diretório de trabalho em que cada `teste:` do manifesto roda | `tools/verificar-prerequisitos.mjs` — o `cwd: RAIZ` de `rodar()` é o que **decide**; o comentário de `acharRaiz` já prometia isso | `MANIFESTO.yaml`, bloco *CONTRATO DE EXECUÇÃO* no cabeçalho de `prerequisitos:`, que é onde quem escreve um `teste:` lê a garantia | O código manda. Removendo ou trocando o `cwd`, o bloco do manifesto muda na mesma alteração — senão ele segue prometendo a quem escreve um `teste:` uma garantia que deixou de valer, e um teste que fale de `origin` passa a examinar o remote do clone do tronco. Este é o par que autoriza mexer no script sem ferir a regra de "nunca acrescente checagem no script": consertar **como** o executor roda é dele; **o que** se checa é do manifesto. |
| Armadilha do teste de acesso que pendura (HTTPS sem credencial) | `.claude/skills/oratia-conhecimento/SKILL.md`, *Armadilhas verificadas na prática* — sintoma, causa, correção e os tempos medidos | **Quatro** satélites, em dois papéis. *Prevenção:* `README.md` (o aviso na subseção de HTTPS, que manda autenticar antes de rodar o verificador) e `MANIFESTO.yaml` (o comentário do item, com os tempos por transporte). *Busca por sintoma:* `INSTALACAO.md` (linha na tabela de diagnóstico, passo 3) e `oratia-ambiente` (a seção *Diagnóstico* desta skill) | A skill de conhecimento é o índice das armadilhas e manda. Mudando a correção — ou deixando o item de tocar a rede —, os **cinco** mudam. E note a divisão de papéis: os dois de busca por sintoma são os únicos que um colaborador consulta **enquanto** o problema acontece, então são os que não podem ficar velhos. |
| **Fronteira do compartimento** — regra inviolável | `CLAUDE.md`, seção *Fronteira do compartimento* | `README.md`, dentro do **prompt colável**, em versão **condensada e deliberada** | Duplicata excepcional, e a razão é o que a autoriza: o prompt é colado numa sessão que **não tem o `CLAUDE.md` carregado**, porque o workspace ainda não existe. Sem a cópia, a montagem inteira correria sem a fronteira em contexto. O `PRIMER.md` recusa repetir as invioláveis **nele**, que é sempre carregado junto do `CLAUDE.md` — não é o caso aqui. Mudando a fronteira, o prompt muda na mesma alteração, e a cópia diz de si que é condensada e que o `CLAUDE.md` prevalece assim que existir. |

## Ao mudar o ambiente

1. Mudou pré-requisito? Vai no `MANIFESTO.yaml`, nunca no script.
2. O fato aparece em outro arquivo? Consulte a matriz acima e propague na mesma
   alteração. Sendo um fato novo duplicado, **acrescente a linha na matriz**.
3. Execute o que escreveu antes de escrever. Não podendo, marque
   `verificado: false` no manifesto e diga isso ao usuário.
4. Rode o verificador e confirme zero bloqueios.
5. Commit **na raiz do workspace** — nunca dentro de `super-ta/`.

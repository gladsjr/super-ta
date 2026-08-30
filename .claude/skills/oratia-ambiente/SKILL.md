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

Montagem do zero: siga o `INSTALACAO.md`, que tem os nove passos na ordem de
dependência, cada um com sua verificação.

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
| Lista de pré-requisitos | `MANIFESTO.yaml` (`prerequisitos:`) | — | O verificador **não tem lista própria**: é só executor. Nunca acrescente checagem no script; acrescente no manifesto. |
| Definição do banco (imagem, credenciais, healthcheck) | `super-ta/docker-compose.yml` | `docker-compose.yml` do workspace, por `include` | Nunca copie o serviço `db` para cá. Mudou lá, chega aqui sozinho — exceto a `DATABASE_URL`, que é montada em `x-ambiente-app` e precisa de ajuste manual se usuário, senha ou nome do banco mudarem. |
| Versão do Node | `super-ta/.replit` (`modules = nodejs-20`) | `Dockerfile` (`FROM node:20-…`), `MANIFESTO.yaml` | O tronco manda. Mudou lá, atualize o Dockerfile e reconstrua a imagem. |
| Nome da pasta do clone (`super-ta`) | `.gitignore` desta branch | `docker-compose.yml` (bind mount e `include`), `MANIFESTO.yaml`, `INSTALACAO.md` | Não mude. Precisando mudar, os quatro mudam na mesma alteração. |
| Nome do projeto Compose (`super-ta`) | `docker-compose.yml` (`name:`) | Nomes de volume citados no `INSTALACAO.md` e nesta skill | Mudar renomeia todos os volumes e órfã o banco. Trate como imutável. |
| Porta da aplicação | `.env` (`ORATIA_APP_PORT`), default 5099 | `docker-compose.yml`, `MANIFESTO.yaml`, `INSTALACAO.md`, `oratia-deploy` | Mudando o **default**, atualize os quatro. Mudança pessoal fica só no `.env`. |
| Rota de saúde (`/oral/ping`) | `super-ta/routes/oralExam.js` | `docker-compose.yml` (healthcheck de `app` e de `pack`), `MANIFESTO.yaml`, `INSTALACAO.md` | Se o tronco mudar a rota, os healthchecks passam a reprovar. Atualize os quatro. |
| Nome do segredo da OpenAI | Código do tronco: `OPENAI_API_KEY` | `docker-compose.yml` faz a ponte de `ORATIA_OPENAI_TOKEN`; `.env.example` e `MANIFESTO.yaml` documentam | O colaborador só conhece `ORATIA_OPENAI_TOKEN`. Mudando o nome no tronco, corrija a ponte no compose. |
| Usuários semeados | `.env` (`INITIAL_USERS`) | `MANIFESTO.yaml`, `INSTALACAO.md`, `oratia-deploy` | Mudando o default, atualize os três — inclusive o aviso de que o admin global é o **primeiro** da lista. |
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
| Carregamento diferido de subagente e de hook | `.claude/skills/oratia-conhecimento/SKILL.md` (a armadilha) | `PRIMER.md` (a consequência para releitura), `tools/verificar-atualizacao-sdlc.mjs` (a regex `.claude/(agents\|settings.json)` e a mensagem) | Mudando o que a plataforma carrega quando, os três mudam juntos. A regex do script é o que decide **quando o aviso aparece**; a skill é o que explica **por quê**. |

## Ao mudar o ambiente

1. Mudou pré-requisito? Vai no `MANIFESTO.yaml`, nunca no script.
2. O fato aparece em outro arquivo? Consulte a matriz acima e propague na mesma
   alteração. Sendo um fato novo duplicado, **acrescente a linha na matriz**.
3. Execute o que escreveu antes de escrever. Não podendo, marque
   `verificado: false` no manifesto e diga isso ao usuário.
4. Rode o verificador e confirme zero bloqueios.
5. Commit **na raiz do workspace** — nunca dentro de `super-ta/`.

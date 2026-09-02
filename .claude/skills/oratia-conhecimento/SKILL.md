---
name: oratia-conhecimento
description: >-
  Conhecimento operacional do ORATIA que não é dedutível do código: topologia do
  ambiente local, credenciais de teste, armadilhas verificadas na prática,
  decisões do workspace e seu porquê, e divergências conhecidas entre a
  documentação (deste workspace e do tronco) e a realidade. Use quando o pedido for entender por que
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
| Armadilha do **ferramental de agente** (skill, subagente, hook, carregamento) | esta skill |
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

**Acento vira `�`, ou um travessão vira hífen, ao criar dado pela linha de
comando no Windows.** Sintoma observado: um trabalho criado por `curl` aparece
na tela como `TESTE MANUAL � padr�o do produto (voz + v�deo)`. Não mexa em
fonte, `<meta charset>` nem no encoding do Postgres — os três já estão em UTF-8.
O dado está corrompido **no banco**, e a tela o exibe fielmente: a perda
acontece antes de o servidor receber.

São **dois problemas independentes**, com correções diferentes. As seis linhas
abaixo são de uma **única corrida**, todas enviando o mesmo corpo
`{"n":"padrão—vídeo"}` a um servidor de eco que imprime o hex do que recebeu. O
resto dos bytes é ASCII e saiu idêntico em todas; a coluna mostra só os três
caracteres que variam:

| Cliente | Como o corpo foi enviado | `ã` `—` `í` na rede |
|---|---|---|
| `/mingw64/bin/curl` — o do Git Bash | `-d '…'` | `e3` `97` `ed` — Windows-1252 |
| o mesmo binário | `--data-binary @arquivo` | `c3a3` `e28094` `c3ad` — **UTF-8** |
| `C:\Windows\System32\curl.exe` | `-d '…'` | `c3a3` `e28094` `c3ad` — **UTF-8** |
| `node.exe` do host | `process.argv` | `c3a3` `e28094` `c3ad` — **UTF-8** |
| `Invoke-RestMethod` | `-ContentType "application/json"` | `e3` `2d` `ed` — Windows-1252 |
| o mesmo | `+ "; charset=utf-8"` | `c3a3` `e28094` `c3ad` — **UTF-8** |

**1. O `curl` do Git for Windows destrói acento passado em argumento.** Nesta
máquina, `curl 8.7.1 (x86_64-w64-mingw32)`. Não é a fronteira do MSYS, não é
"argumento para executável nativo" e não é a distribuição inteira: no mesmo
shell, com o mesmo argumento, o `curl.exe` do Windows e o `node.exe` recebem
UTF-8 intacto — e o próprio `git.exe`, que vem da **mesma** instalação do Git
for Windows, guarda `c3a3 e28094 c3ad` numa mensagem passada por argumento
(`git tag -m 'padrão—vídeo'`). Só este binário estraga. Note o que os
controles fecham e o que deixam aberto: eles **localizam**
a perda dentro dele, no caminho do argumento, mas não separam qual passo interno
converte. Duas correções, ambas verificadas: mande o corpo por
`--data-binary @arquivo` — heredoc e `printf` são builtins do shell e gravam
UTF-8 correto —, ou chame `/c/Windows/System32/curl.exe`. Nenhuma das duas
depende do build, então valem noutra máquina mesmo que o curl de lá seja outro;
o que depende do build é o **diagnóstico**, e aí vale refazer esta tabela.

**2. O `Invoke-RestMethod` codifica o corpo conforme o charset declarado.** Ele
roda no processo e não monta argumento nenhum: o que muda entre as duas últimas
linhas é só o `-ContentType`. Sem charset, usa a codepage; com `charset=utf-8`,
UTF-8. Correção: **declare o charset**. Trocar argumento por arquivo aqui não
resolve nada, porque o argumento não é o problema.

A codepage de destino é a mesma nos dois casos, `Windows-1252` — o que
`[System.Text.Encoding]::Default.WebName` responde nesta máquina. Para o caminho
do `curl`, porém, a evidência são os próprios bytes da tabela, não o .NET:
`e3`, `97` e `ed` são exatamente `ã`, `—` e `í` em CP1252. O `0xE3` solitário não
é UTF-8 válido, e o valor chega ao banco como U+FFFD (`ef bf bd`).

**Cuidado com o travessão, que corrompe sem parecer corrompido.** Pelo `curl` do
Git Bash ele vira `0x97`, e daí U+FFFD, visível na tela. Pelo `Invoke-RestMethod`
sofre *best-fit* e vira um hífen `-` comum: o nome fica plausível e ninguém
percebe. Essa diferença serve de perícia — é a única coluna em que os dois
caminhos divergem, e foi ela que apontou qual deles criou os nomes estragados
desta sessão, depois de a suspeita inicial ter recaído sobre o PowerShell e os
bytes a desmentirem.

**Os bytes não voltam, mas o registro se reescreve.** U+FFFD não guarda o que
substituiu. O dado gravado, porém, é só um dado: os nomes desta sessão foram
corrigidos por `PATCH /admin/works/<token>/name`, com o corpo em arquivo, e o
banco ficou com zero U+FFFD — conferido em todas as colunas de texto e `jsonb`,
não só em `works.name`.

**Dentro do container não há nenhum dos dois problemas** — mais uma razão para o
ferramental que gera dado morar em `tools/` e rodar por `docker compose exec`.
Verificado que o próprio `docker compose exec … node -e … 'ã—í'` entrega
`c3a3 e28094 c3ad` ao container: o `docker.exe` não estraga o argumento.

Nenhum comando registrado neste workspace passa texto não-ASCII por argumento —
os únicos acentos dentro de bloco `bash` estão em comentários, que o shell
descarta (verificado nos artefatos versionados e nos scripts de `tools/`). A
armadilha aparece quando **alguém digita** um nome acentuado.

**npm 11 bloqueia scripts de instalação.** No host com npm 11, `bcrypt` e
`onnxruntime-node` têm o install script barrado pela política `allow-scripts`,
com o aviso perdido no fim de um log longo. Aqui funcionaram por haver
*prebuild* — numa plataforma sem prebuild, quebrariam. Dentro do container o
npm é 10.8.2 e o problema não existe. É mais uma razão para não instalar
dependências no host.

**`onnxruntime-node` baixa CUDA sem GPU.** O postinstall busca na nuget os
providers nativos, CUDA e TensorRT inclusos. São centenas de megabytes: a
primeira instalação demora, e numa rede restrita é aqui que ela falha.

**Subagente novo não fica disponível na hora — e hook novo, só na próxima
sessão.** São dois comportamentos diferentes, e confundi-los custa tempo.

Verificado nesta ordem, na mesma sessão:

1. `.claude/agents/oratia-revisor.md` foi criado;
2. usá-lo imediatamente falhou com `Agent type 'oratia-revisor' not found`;
3. **mais tarde, na mesma sessão, ele apareceu** — a plataforma anunciou
   `New agent types are now available`.

Ou seja: **a descoberta é diferida, não presa à sessão**. A primeira conclusão
registrada aqui — "só vale na próxima sessão" — estava errada: generalizou a
partir da falha do passo 2, antes de o passo 3 acontecer. Fica como exemplo do
que a regra "verifique, não presuma" custa quando se conclui cedo demais.

Skills, por contraste, valem assim que o arquivo é gravado.

Consequências práticas:

- Criando ou alterando um subagente, **não conte com ele em seguida**. Precisando
  usá-lo já, chame um agente genérico mandando-o ler a definição em
  `.claude/agents/<nome>.md` e proibindo-o explicitamente de escrever — a
  independência se mantém; a garantia por ferramenta, não. Foi assim que a
  primeira revisão deste workspace rodou.
- **Configuração de hook (`.claude/settings.json`) é outra história**: um hook
  de `SessionStart` declarado numa sessão não roda nela, porque o gancho já
  passou. Só a sessão seguinte o executa.
- O comportamento do hook de atualização foi verificado chamando o script
  diretamente, com `CLAUDE_PROJECT_DIR` definido, e não pela via do hook —
  que nesta sessão não tinha como disparar.

**O agent que autentica o push não é o que o Git Bash consulta.** Diretriz do
usuário, nas palavras dele: o push usa *"sempre o ssh-agent que tem a chave
registrada"*.

Como isso funciona **nesta máquina** — e o que confunde o diagnóstico:

- `ssh-add -l` no Git Bash responde `Could not open a connection to your
  authentication agent`, e `SSH_AUTH_SOCK` vem vazio. Isso **não** significa
  que falta chave: significa que não há agent do lado do Git Bash. Ele não
  consultou o agent errado — não havia socket a consultar.
- O git aqui usa `core.sshCommand = C:/Windows/System32/OpenSSH/ssh.exe`, ou
  seja, o **ssh do Windows**, que conversa com o **ssh-agent service do
  Windows** por named pipe. São implementações que não compartilham chaveiro.
- Para enxergar as chaves desse agent:
  `C:\Windows\System32\OpenSSH\ssh-add.exe -l`.

**Confirme de onde a chave vem, em vez de supor.** Só `ssh -v` distingue: a
linha de oferta traz `explicit` quando a identidade veio do `IdentityFile`, e
`agent` quando é o agent que assina. Verificado aqui: sai `explicit agent` — as
duas coisas. Note que **a chave privada também está em disco**: o agent é o
caminho em uso, não o único possível; sem ele o ssh leria o arquivo. (Se isso
pediria passphrase, não se verificou — não presuma que a ausência de prompt
prova que o agent está no caminho. O que prova é a linha do `-v`.)

```bash
ssh -vT -o BatchMode=yes <host-alias>
```

Confira duas coisas na saída: o `Hi <conta>!` — exit code 1 é normal, o GitHub
não dá shell — e **o nome da conta**, que é o que revela chave trocada.

> **Como fixar a chave certa é assunto do `README.md`, seção 3.** Não repita a
> prescrição aqui: ela tem duas partes, e uma cópia parcial engana mais que
> nenhuma. Esta skill registra só **como diagnosticar**.
>
> Nesta máquina o mecanismo em vigor não é o do roteiro — `core.sshCommand` só
> aponta o ssh do Windows, e `IdentitiesOnly`/`IdentityFile` vive no
> `~/.ssh/config`, por host alias. Divergência registrada na tabela abaixo, com o
> que os dois têm de diferente.

**Ao ler o `~/.ssh/config` pelo Git Bash, não passe o caminho por `eval`.** No
Git for Windows `HOME` é `%USERPROFILE%`, então `~/.ssh/config` e
`%USERPROFILE%\.ssh\config` são **o mesmo arquivo** — não há dois configs a
divergir. E `test -f` aceita caminho em forma Windows, sem conversão nenhuma.

O que produz falso negativo é o `eval`: verificado que passar
`C:\Users\<user>\.ssh\<chave>` por `$(eval echo "$var")` devolve
`C:Users<user>.ssh<chave>` — o `eval` consome as barras invertidas, e o teste
conclui que o arquivo não existe. Leia o valor direto, sem `eval`. Precisando
converter para POSIX de fato, `cygpath -u` existe aqui (`/usr/bin/cygpath`) e
resolve — mas para testar existência não é necessário.

**O Compose injeta no container o ambiente de QUEM O INVOCA — e chave vazia
não faz barulho.** Verificado duas vezes, a segunda por eu mesmo cair nela:

- variável de ambiente de **sistema** não chega a shell já aberto. Definindo
  `ORATIA_OPENAI_TOKEN` agora, a sessão de terminal que já estava aberta segue
  sem vê-la — e `docker compose up` dali injeta **vazio**;
- o container sobe saudável, o health check passa, e o primeiro sintoma aparece
  longe da causa: a rota do enunciado devolve **HTTP 200** mesmo quando o upload
  à OpenAI é recusado (a falha só sai no log do servidor, como
  `enunciado openai-upload failed`), e o erro visível vira um 500 no `/start`.

Diagnóstico: `docker compose exec app node -e "console.log(!!process.env.OPENAI_API_KEY)"`.
Correção: recriar o serviço de um shell que veja a variável —
`docker compose up -d --force-recreate app`. O validador da jornada checa isso
no passo 0, justamente para o sintoma não aparecer cinco passos adiante.

**A entrevista nasce por VOZ, com fiscalização, e isso é decisão — não default
de schema.** `lib/db/works.js#createWork` faz um UPDATE pós-insert:
`interaction_mode = 'audio', proctoring_enabled = true` quando
`kind = 'interview'`, com o comentário de que os dois são "FIXOS (o professor
não configura mais isso)". O default da **coluna** segue `text`, e é por isso
que consultar `information_schema` engana: ele diz `text` e o trabalho nasce
`audio`.

Consequência para quem testa: uma jornada em texto exige `POST
/w/<token>/interaction` com `{"mode":"text"}` **antes** de o aluno subir o
trabalho. Isso é desvio do produto, aceitável para validar a cadeia cognitiva —
e verde em texto **não** valida a cadeia de voz.

**A ordem da jornada não é a intuitiva**, e cada passo fora de ordem devolve um
erro que não diz qual é a ordem certa:

1. `POST /admin/works` — cria o trabalho;
2. `POST /w/<t>/enunciado` — enunciado em PDF;
3. `POST /w/<t>/interaction` — modo (só se quiser texto);
4. `POST /w/<t>/interviewer` — persona em YAML. **Sem isto**, o upload do aluno
   responde *"O professor ainda não configurou o entrevistador"*;
5. `POST /w/<t>/submissions` — gera o link do aluno;
6. `POST /s/<st>/start` — **antes** do upload. Fora de ordem, o upload responde
   *"sessão não iniciada — recarregue a página"*;
7. `POST /s/<st>/upload` — trabalho do aluno; é aqui que o PrepBuilder roda;
8. `POST /s/<st>/chat` — turnos.

**Dois dos três harnesses E2E de texto do tronco não rodam fora da máquina do
autor** — e o terceiro roda. `tests/text-e2e-mineracao.mjs` e
`tests/text-e2e-adversarial.mjs` têm um caminho absoluto de outro usuário e
dependem de PDFs que vivem lá — em qualquer outra máquina falham antes de
começar. A matriz de validação do `oratia-improve` **recomendava** o primeiro;
foi corrigida em 31/08/2026 para desaconselhá-lo por nome e apontar o portável.

**`tests/text-e2e-sponsor-ancoragem.mjs`, porém, é portável**: gera os PDFs na
hora e usa `lib/scenarios/testWorkGen.js#textToPdfBuffer`. Considere-o antes de
escrever driver novo. O `tools/validar-jornada-ia.mjs` deste workspace existe por
outro motivo — validar o AMBIENTE, com prova lida do banco — o critério exato é o `const ok` do próprio script, descrito no `MANIFESTO.yaml` — e **reusa** aquele
mesmo `textToPdfBuffer`, em vez de reimplementá-lo.

**Ferramental do workspace roda dentro do container por `/ferramental`.** O
compose monta `./tools` ali, só leitura. Um script em `/ferramental` que precise
de dependência do tronco não a resolve pelo caminho normal — o resolvedor de ESM
procuraria em `/ferramental/node_modules`, que não existe. A saída é
`createRequire("/app/")`, que ancora a resolução onde as dependências estão.

**`npm run dev` não funciona dentro do container.** O `predev` chama `db:up`,
que tenta iniciar o Docker Desktop **do host**. Use os serviços separados.

**O bind mount atravessando WSL2 é 77x mais lento na escrita.** Medido: 583
contra 45.145 arquivos por segundo. Vale para qualquer operação com muitos
arquivos pequenos.

## Divergências entre a documentação e a realidade

Verificadas por execução. Não "corrija" o ambiente para casar com elas.

| O documento diz | A realidade | Como tratar |
|---|---|---|
| `AGENTS.md`: clone do Claude em `…/ORATIA/super-ta-repo`, banco `oratia_claude`, porta `:5000` | A pasta é `super-ta`, o banco é `superta`, a porta é 5099 | Aquela tabela descreve **uma** máquina, com três agentes e bancos legados que aqui não existem. A **regra** de isolamento é válida; a **tabela** não é fonte para este workspace |
| `.env.example` do tronco: `PORT=5099` | O default do código é 5000 (`lib/config.js`) | Ambos "certos": o código tem um default, o exemplo sugere outro. Aqui vale 5099, pelo AirPlay do macOS |
| Skill antiga: "Node precisa ser 20.x" | O host tem 24 e o `npm install` passa | Irrelevante agora: a versão que importa é a da imagem |
| `README.md` do workspace: clone por `git@github.com:…` | O remote real usa um alias SSH | O alias é configuração de máquina; a URL genérica no roteiro está correta |
| `README.md` seção 3 prescreve fixar a chave por `core.sshCommand` no repositório (ver lá o comando, que tem duas partes) | Nesta máquina o `core.sshCommand` só aponta o ssh do Windows, e o `IdentitiesOnly`/`IdentityFile` vive no `~/.ssh/config`, por host alias | Nenhum está errado, e **os escopos não são os mesmos** — comparação por leitura, não medida: `core.sshCommand` fixa a identidade **do repositório** (vale para qualquer host que ele use, e **não** sobrevive a um clone novo); `IdentitiesOnly`/`IdentityFile` num bloco `Host` fixa **do alias** (vale para qualquer clone que use o alias, e **não** vale para remote escrito sem ele). Não "corrija" a máquina para casar com o roteiro — mas note que um clone cujo remote não use o alias fica sem proteção, que é o caso que o README endereça |

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

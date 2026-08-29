# Instalação do ambiente ORATIA

Roteiro executável, do zero até a aplicação respondendo. Todos os comandos
foram executados nesta ordem numa máquina que não tinha nada do ORATIA — o que
está aqui é o que de fato funcionou, não o que se imaginava que funcionaria.

Rode tudo a partir da **raiz do workspace** (a pasta que contém o
`MANIFESTO.yaml`). Nenhum comando precisa de caminho absoluto.

**Todo o ambiente roda em containers.** Você não precisa de Node, ffmpeg,
Python nem Postgres instalados na máquina para a aplicação funcionar — a
imagem traz tudo. O Node do host é usado só pelo verificador de
pré-requisitos.

---

## Antes de começar

Precisa existir na máquina: **Docker** (no Windows, com backend **WSL2**),
**Git** e, para rodar o verificador, **Node 18+**. O passo 3 confere isso e
diz o que fazer se faltar algo.

---

## Passo 1 — Obter o código da aplicação

O workspace e o código são repositórios distintos. Este passo traz o segundo
para dentro do primeiro.

```bash
git clone <url-do-tronco> super-ta
```

A pasta **precisa** se chamar `super-ta`: é esse nome que o `.gitignore` desta
branch exclui. Com outro nome, o clone inteiro entraria no índice do
workspace.

**Verificação** — o arquivo tem de existir:

```bash
test -f super-ta/package.json && echo "clone OK" || echo "clone AUSENTE"
```

Pule este passo se a pasta `super-ta/` já estiver aí.

---

## Passo 2 — Criar a configuração local

```bash
cp .env.example .env
```

O `.env` é ignorado pelo git e guarda o que varia por pessoa: portas e, se
você quiser, a chave da OpenAI. Os defaults funcionam sem edição.

**Verificação:**

```bash
test -f .env && echo ".env OK" || echo ".env AUSENTE"
```

Se o `.env` já existir, **não o sobrescreva** — você perderia sua configuração.

---

## Passo 3 — Conferir os pré-requisitos

```bash
node tools/verificar-prerequisitos.mjs
```

Lê a lista do `MANIFESTO.yaml` e reporta **OK**, **FALTA** ou **AVISO**, cada
pendência com a ação que a resolve. Sai com código diferente de zero havendo
qualquer bloqueio.

Siga adiante quando a última linha disser **zero bloqueios**. Avisos não
impedem: o mais comum é a chave da OpenAI ausente, e o ambiente sobe sem ela.

*Sem Node no host?* Instale o Node 18+ — não há substituto por container aqui,
e a razão é conceitual, não de configuração: **o verificador examina o host**
(se o Docker responde, se o backend é WSL2, se a porta está livre). Rodando
dentro de um container ele veria o ambiente do container, e todos esses testes
perderiam o sentido.

Enquanto isso, os passos 4 a 9 funcionam sem ele: cada um traz a própria
verificação, e é isso que o verificador automatiza.

---

## Passo 4 — Construir a imagem da aplicação

```bash
docker compose build app
```

Traz Node 20, ffmpeg e os certificados. A primeira execução baixa a imagem
base e leva alguns minutos; as seguintes reaproveitam o cache.

**Verificação** — a imagem tem de responder com a versão fixada, qualquer que
seja a do host:

```bash
docker compose run --rm --no-deps app node --version
```

Espere `v20.20.2` (ou outra 20.x). Se sair a versão do **seu** Node, o comando
rodou fora do container.

---

## Passo 5 — Subir o banco

```bash
docker compose up -d db
```

PostgreSQL 16 num container, com healthcheck. A definição vem do
`docker-compose.yml` do tronco, incluído pelo do workspace — há uma fonte só.

**Verificação:**

```bash
docker compose ps db
```

A coluna de estado precisa dizer **healthy**. Em `starting`, espere alguns
segundos e repita; o primeiro boot inicializa o cluster.

---

## Passo 6 — Instalar as dependências

```bash
docker compose run --rm deps
```

Instala no volume `super-ta_node-modules-linux`, **não** na sua pasta. São duas
razões independentes, ambas medidas:

- **Plataforma.** `bcrypt` e `onnxruntime-node` são binários nativos. Os que o
  host compila (Windows ou macOS) não carregam no Linux do container.
- **Velocidade.** Escrita no bind mount é **77x mais lenta** que no
  filesystem do container (medido: 583 contra 45.145 arquivos por segundo). Um
  `npm install` com dezenas de milhares de arquivos é inviável ali.

Repita este passo sempre que o `package-lock.json` mudar.

**Verificação** — termina com `added N packages` e sem erro. A saída dos
scripts de instalação dos módulos nativos aparece na tela de propósito
(`--foreground-scripts`): escondida, uma falha só reapareceria muito depois,
como um módulo que não carrega.

---

## Passo 7 — Aplicar as migrations

```bash
docker compose run --rm migrate
```

Passo separado porque **o boot da aplicação não roda DDL** — é decisão
arquitetural do tronco, não esquecimento. Rode de novo depois de todo `git
pull` que traga migrations novas.

**Verificação:**

```bash
docker compose run --rm migrate npm run db:migrate -- status
```

Termina em `N/N aplicadas, 0 pendentes`.

---

## Passo 8 — Subir a aplicação

```bash
docker compose up -d app
```

**Verificação:**

```bash
docker compose ps app
```

Estado **healthy** — o healthcheck bate na rota de saúde do próprio produto, então
`healthy` já significa "respondendo HTTP".

---

## Passo 9 — Validar que responde de verdade

```bash
curl -s http://localhost:5099/oral/ping
```

Responde exatamente `ok`.

Autenticação de ponta a ponta, com um usuário semeado:

```bash
curl -s -X POST http://localhost:5099/login -H "Content-Type: application/json" -d '{"username":"professor","password":"senha123"}' -c cookie.txt
```

E confirmando a sessão:

```bash
curl -s http://localhost:5099/me -b cookie.txt
```

Espere `is_global_admin: true`.

> **Use `professor`, não `admin`.** O admin global é o **primeiro** usuário de
> `INITIAL_USERS` — que no default é `professor`. O usuário chamado `admin`
> existe e loga, mas **não** é administrador, e criar trabalho com ele devolve
> `403 forbidden_tokenless_work`. Ver a explicação na skill
> `oratia-conhecimento`.

No navegador: `http://localhost:5099/` para a landing, `http://localhost:5099/admin`
para entrar com o usuário semeado.

---

## O que fica por validar sem a chave da OpenAI

Tudo acima funciona sem chave. **Não** foi validado, e depende dela:

- subir enunciado e trabalho em PDF (indexação em Vector Store);
- qualquer turno de entrevista, prova oral ou transcrição;
- avaliação e devolutiva.

Com a chave em mãos, defina `ORATIA_OPENAI_TOKEN` no ambiente ou no `.env`,
recrie o container (`docker compose up -d --force-recreate app`) e siga o
fluxo pela interface: `/admin` → criar trabalho → `/w/<token>` para subir o
enunciado → link de aluno `/s/<token>`. Consome créditos de API.

---

## Comandos do dia a dia

| Para | Comando |
|---|---|
| Ver o estado de tudo | `docker compose ps` |
| Acompanhar o log | `docker compose logs -f app` |
| Reiniciar após mexer no código | `docker compose restart app` |
| Recriar após mexer no `.env` | `docker compose up -d --force-recreate app` |
| Abrir um shell no container | `docker compose run --rm --no-deps app bash` |
| Abrir o psql | `docker exec -it superta-db psql -U superta -d superta` |
| Parar tudo, preservando os dados | `docker compose down` |
| **Apagar tudo, inclusive o banco** | `docker compose down -v` |
| Validar o empacotamento | `docker compose --profile pack up -d --build pack` |

`docker compose down -v` remove os volumes: o banco volta ao zero e as
dependências somem. Para recomeçar, repita os passos 5 a 8.

---

## Diagnóstico — sintoma → passo → causa

| Sintoma | Volte ao passo | Causa e correção |
|---|---|---|
| `docker: command not found` / `Cannot connect to the Docker daemon` | 3 | Docker não instalado ou parado. No Windows e no macOS, abra o Docker Desktop e espere ficar verde. |
| `include is not supported` no `docker compose` | 3 | Compose anterior à v2.20. Atualize o Docker. O `docker-compose` com hífen é a v1 e não serve — use `docker compose`. |
| Kernel sem `WSL2` no verificador (Windows) | 3 | Docker Desktop em backend Hyper-V. Settings → General → "Use the WSL 2 based engine". |
| `no such file or directory: super-ta/package.json` | 1 | Clone ausente ou com outro nome. A pasta precisa se chamar exatamente `super-ta`. |
| `Cannot find module '/app/C:/Program Files/Git/...'` | — | Git Bash no Windows converteu o caminho do container em caminho Windows. Prefixe o comando com `MSYS_NO_PATHCONV=1`. |
| `bind: address already in use` ao subir `app` | 2 | Porta ocupada. Mude `ORATIA_APP_PORT` no `.env` e recrie o container. |
| Verificador diz "porta livre" e o `up` falha mesmo assim | — | Não deve mais ocorrer: o teste de porta usa conexão, não bind. No Windows o bind sucede mesmo com a porta publicada pelo Docker — por isso ele sozinho dava falso OK. |
| `Error: connect ECONNREFUSED ... 5432` | 5 | Banco não subiu ou ainda não está `healthy`. `docker compose ps db` e espere. |
| Boot morre citando `policy.yaml` ou `pricing.yaml` | 6 | Configuração inválida. O boot é fail-fast de propósito — leia a mensagem e corrija o arquivo, não contorne. |
| `Cannot find module 'express'` ou similar | 6 | `deps` não rodou, ou rodou antes de o volume existir. Rode `docker compose run --rm deps`. |
| Módulo nativo não carrega (`bcrypt`, `onnxruntime`) | 6 | Volume de `node_modules` populado pelo host. `docker compose down -v` e refaça do passo 5. |
| `relation "..." does not exist` | 7 | Migrations não aplicadas. `docker compose run --rm migrate`. |
| `403 forbidden_tokenless_work` ao criar trabalho | 9 | Logado como `admin`, que não é o admin global. Use `professor`. |
| Login com a senha do `.env` não funciona | — | O seed só cria usuário que ainda não existe; mudar a senha depois não a reaplica. Use a senha antiga ou remova o usuário do banco. |
| Sessão cai a cada restart | 2 | `SESSION_SECRET` vazio: o servidor usa um segredo efêmero e avisa no log. Defina um valor no `.env`. |
| Qualquer jornada de entrevista falha | — | Chave da OpenAI ausente ou sem crédito. Rode o verificador; investigue com `LOG_LEVEL=debug`. |
| Tudo lento no Windows | — | Bind mount atravessando a fronteira Windows↔WSL2 (77x mais lento na escrita). Esperado. Mantenha `node_modules` no volume — nunca no bind mount. |
| `npm run dev` falha tentando abrir o Docker Desktop | 8 | Não use `npm run dev` dentro do container: o `predev` chama `db:up`, que tenta iniciar o Docker do host. Os passos 5 a 8 fazem o equivalente, separados. |

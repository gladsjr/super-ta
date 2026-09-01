---
name: oratia-deploy
description: >-
  Sobe o ORATIA em containers e valida que a aplicação responde de verdade:
  banco, aplicação, health check, login real e escrita no banco. Cobre também
  logs, reinício, recriação após mudar configuração, a validação da jornada com
  IA e o que ela não cobre. Use quando o pedido for subir, rodar, iniciar, reiniciar,
  parar ou validar a aplicação — frases como "sobe o oratia", "roda o super-ta",
  "deploy local", "a aplicação não responde", "o container reinicia sozinho",
  "não consigo logar", "está no ar?". NÃO use para preparar a máquina (use
  oratia-ambiente), para construir imagem ou aplicar migrations (use
  oratia-build) nem para evoluir o código (use oratia-improve).
---

# Subir e validar o ORATIA

Escopo: **ambiente local, em containers**. Rode tudo a partir da raiz do
workspace.

Este ambiente pressupõe imagem construída, dependências no volume e migrations
aplicadas — se algum desses faltar, vá primeiro à skill `oratia-build`. Máquina
nova: `INSTALACAO.md`, do começo.

## Subir

```bash
docker compose up -d db app
```

`app` só inicia depois de o `db` ficar `healthy` — a dependência está declarada
no compose, então não é preciso esperar entre os dois.

**Verificação:**

```bash
docker compose ps
```

Os dois precisam dizer **healthy**. Como o healthcheck do `app` bate na rota de
saúde do produto, `healthy` já significa "respondendo HTTP" — não só "processo
vivo".

## Validar que responde de verdade

Health check nenhum prova que a aplicação **funciona**. Esta sequência foi
executada e passa sem a chave da OpenAI.

**1. Saúde pública**

```bash
curl -s http://localhost:5099/oral/ping
```

Responde exatamente `ok`.

**2. Login real com um usuário semeado**

```bash
curl -s -X POST http://localhost:5099/login -H "Content-Type: application/json" -d '{"username":"professor","password":"senha123"}' -c cookie.txt
```

Devolve `{"ok":true,...}` e grava a sessão em `cookie.txt`.

**3. Sessão autenticada**

```bash
curl -s http://localhost:5099/me -b cookie.txt
```

Espere `is_global_admin: true`.

**4. Escrita real no banco**

```bash
curl -s -X POST http://localhost:5099/admin/works -H "Content-Type: application/json" -b cookie.txt -d '{"name":"Verificacao","kind":"interview"}'
```

Devolve o trabalho criado, com `work_token`. Confirmando por fonte
independente:

```bash
docker exec superta-db psql -U superta -d superta -tAc "SELECT id, name FROM works;"
```

> **Use `professor`, nunca `admin`.** O admin global é o **primeiro** usuário de
> `INITIAL_USERS`, e o default começa por `professor`. O usuário chamado `admin`
> loga normalmente mas **não** é administrador: criar trabalho com ele devolve
> `403 forbidden_tokenless_work`. A mecânica está na skill
> `oratia-conhecimento`.

## Validar a jornada com IA

Os passos acima não tocam a OpenAI. Para validar a cadeia cognitiva:

```bash
docker compose exec app node /ferramental/validar-jornada-ia.mjs
```

**Consome créditos de API.**

**Aprovado exige cinco condições ao mesmo tempo**: nenhum turno falho; e
`interview_plan`, `work_analysis` e `vector_store_id` observados em
`submissions.runtime_state_json`, com `current_phase` chegando a
`interviewing`. **Turno respondido não é critério** — o beat de introdução
responde sem prep e sem orquestrador.

A prova é lida do banco a cada turno, e acumulada: se o orquestrador finalizar,
o handler zera o estado (comportamento correto), e uma consulta única no fim
reprovaria uma execução que funcionou.

**A armadilha que pega quase todo mundo**: o Compose injeta
`ORATIA_OPENAI_TOKEN` do ambiente de **quem o invoca**. Terminal aberto antes de
a variável existir não a vê, e o container sobe com a chave **vazia** sem
reclamar — o health check passa, a rota do enunciado devolve 200 mesmo com o
upload recusado, e o erro só aparece adiante. O validador detecta no passo 0.
Correção: `docker compose up -d --force-recreate app` de um shell que veja a
variável.

### O que essa validação NÃO cobre

- **A cadeia de voz.** O validador força modo texto, que é desvio declarado: a
  entrevista nasce por voz com fiscalização (decisão em `lib/db/works.js`). Para
  voz, a skill `testar-modo-audio`, no tronco.
- **Avaliação, nota e devolutiva.** O validador não chama `/finalize` nem o
  pipeline de avaliação, então a invariante de dupla sanitização da devolutiva
  fica fora. Continua por validar.

## Operação

| Para | Comando |
|---|---|
| Estado de tudo | `docker compose ps` |
| Acompanhar o log | `docker compose logs -f app` |
| Últimas 50 linhas | `docker compose logs --tail=50 app` |
| Reiniciar após mexer no código | `docker compose restart app` |
| Recriar após mexer no `.env` | `docker compose up -d --force-recreate app` |
| Shell no container | `docker compose run --rm --no-deps app bash` |
| psql | `docker exec -it superta-db psql -U superta -d superta` |
| Parar, preservando os dados | `docker compose down` |
| **Apagar tudo, banco incluído** | `docker compose down -v` |

**Código mudou → `restart` basta.** O bind mount já reflete o disco; não há
rebuild no alvo `dev`.

**`.env` mudou → precisa de `--force-recreate`.** Variável de ambiente entra na
criação do container; `restart` reaproveita o mesmo e não a relê. Esta é a
causa mais comum de "mudei a configuração e nada aconteceu".

## Diagnóstico

A tabela completa está no `INSTALACAO.md`. O que aparece com mais frequência ao
subir:

| Sintoma | Causa e correção |
|---|---|
| `bind: address already in use` | Porta ocupada. Mude `ORATIA_APP_PORT` no `.env` e **recrie**. |
| `app` fica `starting` e vira `unhealthy` | O processo sobe mas não responde. `docker compose logs app` — quase sempre é fail-fast de configuração. |
| Boot morre citando `policy.yaml` / `pricing.yaml` | Configuração inválida. O fail-fast é deliberado: leia a mensagem e corrija o arquivo, não contorne. |
| `ECONNREFUSED ... 5432` | Banco fora do ar. `docker compose up -d db` e espere `healthy`. |
| `relation "..." does not exist` | Migrations pendentes → skill `oratia-build`. |
| `Cannot find module 'express'` | Dependências ausentes no volume → skill `oratia-build`. |
| `403 forbidden_tokenless_work` | Logado como `admin`. Use `professor`. |
| Sessão cai a cada restart | `SESSION_SECRET` vazio: o servidor usa segredo efêmero e avisa no log. Defina no `.env` e recrie. |
| Login não aceita a senha do `.env` | O seed só cria usuário que ainda não existe; alterar a senha depois não a reaplica. Use a antiga ou remova o usuário do banco. |
| Mudei o `.env` e nada mudou | Faltou `--force-recreate`. |

## Antes de dizer que está no ar

- [ ] `docker compose ps` mostra `db` e `app` **healthy**;
- [ ] `/oral/ping` responde `ok`;
- [ ] login com `professor` devolve sessão e `is_global_admin: true`;
- [ ] uma escrita real chegou ao banco;
- [ ] a jornada com IA passou (`validar-jornada-ia.mjs`), ou o que depende da
      OpenAI foi **declarado como não validado**;
- [ ] avaliação, nota e devolutiva seguem **fora** do que o validador cobre — não
      as dê por validadas.

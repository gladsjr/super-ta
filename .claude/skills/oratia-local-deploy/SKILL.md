---
name: oratia-local-deploy
description: >-
  Sobe o ORATIA (super-ta) em ambiente local para teste: PostgreSQL 16 via
  Docker Compose, .env a partir do .env.example, migrations, npm run dev,
  smoke test e diagnóstico dos problemas comuns (Docker parado, porta ocupada,
  migration pendente, chave OpenAI ausente, áudio local, sidecar Python).
  Use SEMPRE que o usuário pedir para subir, rodar, implantar, publicar ou
  testar o ORATIA localmente — frases como "sobe o oratia", "roda o super-ta
  local", "deploy local", "sobe o ambiente", "prepara o ambiente de teste",
  "o servidor não sobe", "erro ao subir o banco". NÃO use para evoluir código
  (use oratia-improve) nem para o E2E de voz (use testar-modo-audio).
---

# Deploy local do ORATIA (super-ta) via Docker

O deploy local = **Postgres 16 em Docker** + **app Node no host**. Não há
imagem Docker do app (o `docker-compose.yml` só define o serviço `db`).
Produção real é Reserved VM no Replit (Publish manual) — local serve para
desenvolvimento e teste.

## Pré-requisitos (verifique ANTES, na ordem)

```bash
node --version        # precisa ser 20.x
docker info           # Docker Desktop rodando (senão scripts/start-db.mjs tenta iniciá-lo)
```

E uma **chave OpenAI válida** — sem ela o servidor sobe, mas nenhuma
entrevista funciona (toda a cognição é na plataforma OpenAI).

## Passo a passo

### 1. Instalar dependências
```bash
npm install
```
Sem build de frontend (HTML/JS puro). Atenção a dois nativos:
- `bcrypt` — compila nativo; no Windows precisa de build tools se o binário
  pré-compilado falhar.
- `onnxruntime-node` — usado só pelo proctoring; é **lazy-loaded**
  (`lib/proctor.js`): se o binário nativo faltar, o boot NÃO quebra, só a
  análise de vídeo fica indisponível.

### 2. Configurar `.env`
```bash
cp .env.example .env
```
Preencher:

| Variável | Valor local | Nota |
|---|---|---|
| `OPENAI_API_KEY` | chave real | obrigatória |
| `DATABASE_URL` | `postgres://superta:superta@localhost:5432/superta` | bate com o docker-compose |
| `SESSION_SECRET` | string qualquer em dev | sem ela, sessões caem a cada restart |
| `INITIAL_USERS` | `professor:senha123,admin:admin123` | seed no boot; formato `user:pass,...` |
| `PORT` | `5099` (ou livre) | evite 5000/5001 (reservadas a outros clones/agentes — ver CLAUDE.md) |
| `AUDIO_STORE_BACKEND` | `local` (ou omitir) | fora do Replit o auto já é `local` (grava em `.audio-store/`) |

Se houver mais de um clone/agente na máquina, cada um usa SEU database no
mesmo container e SUA porta — nunca o do outro (regra dura do CLAUDE.md).
Para criar um database dedicado:
`docker exec superta-db psql -U superta -c "CREATE DATABASE meu_db;"` e
apontar o `DATABASE_URL` para ele.

### 3. Subir tudo
```bash
npm run dev
```
O `predev` encadeia: `db:up` (sobe Docker Desktop se preciso + `docker
compose up -d` do Postgres com healthcheck) → `db:migrate` (aplica as
migrations pendentes, cada uma em transação própria) → `node server.js`.

Passos avulsos, se preferir controle fino:
```bash
npm run db:up                      # só o Postgres
npm run db:migrate                 # aplica migrations pendentes
npm run db:migrate -- status       # lista estado sem aplicar
node server.js                     # sobe o app
npm run db:down                    # derruba o Postgres (dados ficam no volume superta-pgdata)
```

**Migrations rodam SÓ por CLI** (guard `MIGRATIONS_CLI=1` em
`scripts/migrate.mjs`); o boot do servidor nunca toca no schema — é decisão
arquitetural (Publish do Replit materializa prod), não esqueça o
`db:migrate` após puxar mudanças.

### 4. Smoke test
```bash
curl -s http://localhost:5099/oral/ping          # health público → ok
curl -s -X POST http://localhost:5099/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' -c /tmp/c.txt   # login do seed
```
No navegador:
- `http://localhost:5099/` — landing.
- `http://localhost:5099/admin` — logar com o usuário do `INITIAL_USERS`,
  criar um trabalho → a UI dá a **URL de professor** (`/w/<token>`); nela
  sobe-se o enunciado e obtém-se **links de aluno** (`/s/<token>`).
- Fluxo mínimo de fumaça com IA (gasta centavos): criar trabalho → subir
  enunciado PDF → abrir link de aluno → subir um PDF de trabalho → trocar
  2–3 turnos de entrevista em texto.

### 5. (Opcional) Capacidades extras locais
- **Proctoring de vídeo**: exige `ffmpeg` no PATH + Python com
  `pip install -r requirements.txt` (mediapipe, opencv) + apontar
  `PROCTOR_PYTHON` para o interpretador. Sem isso o resto do sistema
  funciona normalmente (fail-open).
- **Prova oral (Realtime)**: funciona local — o relay WebSocket sobe junto
  com o servidor; só precisa da chave OpenAI com acesso ao modelo realtime.
- **GC de áudio**: `npm run audio:gc -- --dry-run`.

## Diagnóstico rápido

| Sintoma | Causa provável → ação |
|---|---|
| `db:up` falha / trava | Docker Desktop parado → abrir e repetir; `docker ps` deve mostrar `superta-db` healthy |
| Boot morre citando policy/pricing | `config/policy.yaml`/`pricing.yaml` inválidos — o boot é fail-fast de propósito; ler a mensagem, não contornar |
| Boot morre citando env | Falta `OPENAI_API_KEY`/`DATABASE_URL` no `.env` |
| `column already exists` ao migrar | Tentativa de reaplicar migration já materializada — conferir `schema_migrations` e `npm run db:migrate -- status` |
| `EADDRINUSE` | Porta ocupada → trocar `PORT` no `.env` |
| Login falha com usuário do seed | Seed só cria usuário que NÃO existe; se mudou a senha no `.env` depois, ela não é re-aplicada — apagar o usuário no banco ou usar a senha antiga |
| Entrevista trava no upload | Chave OpenAI sem crédito/permissão (Files + Vector Stores) — ver log com `LOG_LEVEL=debug` |
| Áudio do aluno não grava | `AUDIO_STORE_BACKEND` mal configurado — local grava em `.audio-store/`; conferir permissões |
| Proctoring falha | Normal sem ffmpeg/Python configurados — é opcional e fail-open |

## O que NUNCA fazer no ambiente local

- Rodar migrations contra banco que não é o seu (`DATABASE_URL` de outro
  clone/agente).
- Editar migration já aplicada para "consertar" — criar corretiva.
- Versionar `.env` ou a chave OpenAI.
- Rodar os harnesses que gastam API (`test:audio`, `test:ab-orchestrator`,
  oral-e2e, scenario-eval) sem avisar o usuário do custo.

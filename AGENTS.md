# AGENTS.md — guia para agentes não-Claude (Codex) no super-ta

Este arquivo é o equivalente, para você (Codex), do `CLAUDE.md`. As convenções
do projeto valem para QUALQUER agente que mexa no código — então **leia também
`CLAUDE.md` e `replit.md`**: a arquitetura, o mapa de prompts e as regras de
migration descritas lá se aplicam igualmente a você. Este arquivo resume o que é
crítico e fixa a **divisão de ambientes** entre os três agentes.

## Divisão de ambientes (Claude / Codex / Replit) — regra dura

Três agentes mexem neste projeto. Cada um trabalha no SEU clone, com o SEU banco
e a SUA porta. **Você (Codex) nunca toca no ambiente dos outros** — não troca a
branch do Claude, não usa a `:5000`, não recria/migra o banco `oratia_claude`,
não mexe no clone `super-ta-repo`.

| Agente | Working tree (clone) | Banco (no container `superta-db`) | Porta | Branch de trabalho |
|---|---|---|---|---|
| Claude | `C:\Users\glads\Dropbox\Projetos\ORATIA\super-ta-repo` | `oratia_claude` | `:5000` | a feature em andamento |
| **Codex (você)** | `C:\Users\glads\Dropbox\Projetos\ORATIA\super-ta-codex` | `oratia_codex` | `:5001` | `feat/multiagent-scenarios-mock` |
| Replit | ambiente próprio (Reserved VM) | banco próprio (dev/prod) | — | `main` |

- O **container Postgres `superta-db`** é compartilhado, mas cada agente usa SÓ o
  seu database. O seu é `oratia_codex`. Sua `.env` já aponta para ele e para a
  `PORT=5001`.
- **Working tree VIVO do usuário** (`C:\Users\glads\src\super-ta`): não toque.
- **`main` é a fonte única** que vai a produção (Replit). Dê push só na SUA
  branch (`feat/multiagent-scenarios-mock`); integração para a `main` é via PR.

## Convenções de código (resumo — detalhe em `CLAUDE.md`)

- **Falhe explícito, sem fallback arquitetural.** Seleção de modelo vem só de
  `config/policy.yaml`. Config obrigatória ausente = falhar no boot, não adivinhar.
- **Migrations file-per-change.** Toda mudança de schema é um arquivo novo
  `migrations/NNN_descricao.sql` (3 dígitos). NUNCA edite uma migration já
  aplicada — crie uma corretiva. Aplique no dev com `npm run db:migrate`. O boot
  NÃO roda migrations; produção é materializada pelo Publish do Replit (que faz
  diff dev→prod). Detalhe e as regras duras estão em `CLAUDE.md`. Atenção a
  colisão de números entre branches: se a `main` já tem `NNN`, renumere a sua.
- **Helpers compartilhados.** Agente de saída estruturada (json_schema,
  não-streaming) usa `lib/agentRun.js#runStructured`. Lote com concorrência
  limitada usa `lib/concurrency.js#mapPool`. Não recrie esses esqueletos à mão.
- **Mapa de prompts.** Todo prompt enviado à LLM deve ser alcançável pelo
  diagrama em `docs/architecture.md`. Ao criar/mover/renomear um prompt ou
  agente, atualize o diagrama, a tabela de navegação e o índice na mesma mudança.
- **Texto vs áudio / Realtime.** Análise é sempre em texto; áudio é só
  última-milha. Nunca passe áudio para um agente.

## Invariantes de privacidade (não negociáveis)

- O **gabarito** da prova oral nunca chega ao browser nem à sessão Realtime — só
  as perguntas (e os aspectos de cobertura). As respostas ficam no servidor.
- O **vídeo** da prova oral nunca vai para a OpenAI. Proctoring é pós-prova e
  local (`lib/proctor.js`, YOLO via onnxruntime + sidecar Python).
- Consentimento (câmera/gravação) é obrigatório antes da prova.

## Idioma

Responda ao usuário em português brasileiro. Evite verbos aportuguesados de
termos em inglês ("deployar", "buildar", "commitar", "mergear"). Termos técnicos
consagrados (commit, deploy, branch, pipeline) podem ficar em inglês.

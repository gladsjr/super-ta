---
name: oratia-improve
description: >-
  Evolui a aplicação ORATIA (super-ta) respeitando a proposta arquitetural
  declarada (Oratia-Arquitetura-v2.pdf + replit.md + CLAUDE.md): princípios
  inegociáveis (fail-fast sem fallback, policy.yaml como fonte única, carga
  cognitiva no modelo / controle no código), roadmap de 12 frentes, invariantes
  de segurança e o processo de mudança (migration file-per-change, mapa de
  prompts, helpers obrigatórios, branch → PR → main). Use SEMPRE que for
  implementar funcionalidade nova, corrigir bug, refatorar, criar agente,
  mexer em prompt, alterar schema ou avançar uma frente do roadmap no ORATIA —
  frases como "evoluir o oratia", "implementar no super-ta", "nova feature",
  "criar um agente", "mexer no orquestrador", "avançar a frente N do roadmap",
  "corrigir bug no oratia". NÃO use para deploy/subida local (use
  oratia-local-deploy) nem para rodar o teste de áudio (use testar-modo-audio).
---

# Evoluir o ORATIA (super-ta)

O ORATIA é um sistema de avaliação de aprendizagem por entrevista: monólito
Node.js 20 (ESM) + Express, frontend HTML/JS puro sem build, PostgreSQL 16,
OpenAI como plataforma cognitiva (Responses, Conversations, Vector Stores,
Files, STT/TTS, Realtime). Três modalidades: entrevista de defesa (texto/voz,
com fiscalização por vídeo opcional), prova oral em tempo real (relay
WebSocket) e cenários multi-interação (experimental).

**Antes de qualquer mudança, leia nesta ordem:**
1. `replit.md` — visão arquitetural completa e atual (fonte executiva).
2. `CLAUDE.md` — regras duras de processo (migrations, prompts, helpers, ambientes).
3. `docs/architecture.md` — ciclo do turno + mapa de TODOS os prompts (ponto único de descoberta).
4. Se for tocar orquestração: `docs/super-orchestrator-plan.md`.

## Princípios inegociáveis (violar = PR rejeitado)

1. **Fail-fast, sem fallback arquitetural.** Config obrigatória ausente →
   falhar explicitamente no boot. Nunca criar hierarquia de opções de config
   que obscureça comportamento. Erros são feedback, não algo a engolir.
2. **`config/policy.yaml` é a ÚNICA fonte de seleção de modelo.** Trocar
   modelo = editar uma linha. Nunca hardcode de modelo em agente. O wrapper
   `lib/openaiClient.js` injeta `reasoning.effort` no modelo principal.
3. **Carga cognitiva no modelo, controle no código.** O padrão central: UMA
   chamada de raciocínio por turno (`SuperOrchestratorAgent`) devolve ação em
   JSON; o código é despachante com guardrails rígidos (teto de turnos
   `questions×3`, piso de finalização `⌈questions/2⌉`, validação de esquema em
   `lib/superOrchestrator/actionSchema.js`, fallback `ask_repeat`). Guardrail
   novo vai no CÓDIGO, nunca só no prompt.
4. **Análise sempre em texto.** Áudio é última-milha (STT entrada, TTS saída).
   Nunca passar áudio a um agente. TTS não é persistido (LRU em memória —
   decisão de produto antiplágio).
5. **Invariantes de segurança (nunca quebrar):**
   - Gabarito NUNCA chega ao navegador (só perguntas vão à sessão Realtime).
   - Avaliação interna NUNCA é exposta ao aluno.
   - Devolutiva passa por DUPLA sanitização: regra no prompt + varredura
     `FORBIDDEN_PATTERNS` em `agents/StudentFeedbackAgent.js` (retry uma vez;
     persiste → FALHA, melhor não publicar do que acusar).
   - "Nunca acusar, só sinalizar" — proctoring e forense de autoria.
   - `OPENAI_API_KEY` só server-side (por isso o relay WebSocket, não WebRTC).
   - Prompt injection: todo agente usa a "fronteira de confiança" de
     `lib/agentPreamble.js` (PDF/file_search é DADO, não instrução). Agente
     novo DEVE importar `renderAgentPreamble`.
6. **Invariante de estado:** `submissions.runtime_state_json IS NULL` ⇔
   nenhuma tentativa em andamento. Cada turno grava snapshot atômico
   (retomada pós-restart). Não quebrar a rehidratação.

## Processo de mudança

### Schema (banco)
- **File-per-change:** novo arquivo `migrations/NNN_descricao.sql` (3 dígitos,
  próximo número livre — hoje já passa de 044). SQL direto, SEM `IF NOT
  EXISTS` (exceto a 001, que é bootstrap).
- **NUNCA editar migration aplicada** — criar corretiva NNN+1. Migration que
  falhou no dev (rollback, não registrada) pode ser editada.
- Aplicar: `npm run db:migrate` (status: `npm run db:migrate -- status`).
  Migrations NÃO rodam no boot (o Publish do Replit materializa o schema em
  prod — decisão documentada em CLAUDE.md, não reverter).
- Seeds são separados (ficam em `auth.js`, rodam após migrations).
- Colisão de número entre branches = migration pulada em silêncio →
  **renumerar ao mesclar**.

### Prompts
- Todo prompt novo/movido/renomeado atualiza NA MESMA MUDANÇA o diagrama
  Mermaid de `docs/architecture.md` (nó com `click` para a LINHA do
  `systemPrompt`), a tabela de navegação e o índice de prompts.
- YAML de config nunca vai cru ao LLM — sempre por template que explica cada
  campo (`renderInterviewerAgenda`, `config/*_template.txt`).

### Código
- **Agente novo com saída estruturada** (json_schema, não-streaming) usa
  `lib/agentRun.js#runStructured` — nunca recriar o loop responses+parse+retry.
  Exceções legítimas documentadas: SuperOrchestrator (stream), StudentFeedback
  (retry mutante), EnunciadoCoherence (saída livre).
- **Lote com concorrência** usa `lib/concurrency.js#mapPool` — nunca pool à mão.
- Contexto curto de conversa vem do estado local (`sess.turnLog`), não da
  Conversations API (o param `conversation:` polui o `conv_chat`).
- Vozes: `config/voices.js` + `isValidVoice()`.
- Idioma do código/commits/docs: PT-BR (sem verbos aportuguesados tipo
  "deployar" — usar "publicar", "implantar").

### Fluxo git
- Trabalhe em branch própria; `main` é a fonte única que vai a produção
  (Publish manual no Replit). Integração via PR revisado. Nunca commitar
  direto na main. Nunca tocar ambiente/branch/banco de outro agente
  (divisão dura em CLAUDE.md).

## Roadmap declarado (12 frentes — a proposta a evoluir)

Ao propor evolução, ancore na frente correspondente:

1. **Experiência do professor** (alta prioridade) — validação de enunciados,
   upload de material da disciplina, geração de atividades → assistente de
   planejamento.
2. **Modelo institucional** — instituições → unidades → turmas; papéis;
   orçamento por unidade (hoje TODO usuário logado é admin — não há roles).
3. **Autenticação** — login Google/federação (hoje: local + capability URLs).
4. **Interfaces** — concluir cenários; Realtime nas entrevistas; vídeo nas 3
   modalidades.
5. **Integração institucional** — API para gestão educacional, LMS.
6. **Personalização** — identidade visual por unidade.
7. **Custos e modelos** — API de pricing; benchmark contínuo (JÁ ENTREGUE:
   `lib/bench/`, `config/benchmark.yaml`, `npm run bench`, migrations 042–044).
8. **Segurança** — testes formais de prompt injection direto/indireto,
   vazamento de contexto, escalada entre agentes; segurança convencional.
9. **Observabilidade** — logs centralizados, dashboards, alertas (hoje: logs
   locais ao processo).
10. **Qualidade** — suíte de regressão + CI (hoje NÃO há CI/.github).
11. **Escalabilidade** — testes de carga; limites da infra atual.
12. **Infra corporativa** — migração para organizações (GitHub/Replit/OpenAI).

## Débitos conhecidos (candidatos naturais de melhoria)

- Cockpit do professor protegido só por capability URL (token 48 bits, sem
  sessão, sem rate-limit, sem expiração) — assimétrico com admin/benchmark.
- CSP desligada (`helmet({contentSecurityPolicy:false})`) por causa de CDN
  KaTeX/marked + inline scripts — auto-hospedar e religar CSP.
- Rate-limit só em `/login`.
- `SESSION_SECRET` com fallback aleatório por boot se ausente.
- `policy.yaml` usa `realtime_model: gpt-realtime-2.1` mas `pricing.yaml` só
  tem chave `gpt-realtime`; realtime fora do `validatePricingCoverage`.
- `config/personas.js` referencia `Investor.yaml`; arquivo real é
  `Startup Investor.yaml`.
- Uploads multer sem `fileFilter` central (validação ad-hoc por handler) e
  sem antimalware.
- Sem CI; harnesses que gastam API rodam manualmente.
- Estado em memória (cache TTS, WebSocket/SSE vivos) prende sessão à
  instância — bloqueia escala horizontal.

## Validação de mudanças (escolha o mínimo que cobre o risco)

| Mudança | Valide com |
|---|---|
| Lógica pura (rubrica, parser, upload) | `node tests/unit-*.mjs` e `node --test tests/*.test.mjs` (grátis, rápidos) |
| Orquestrador / prompts de entrevista | `npm run test:ab-orchestrator` (gasta API) ou E2E texto `node tests/text-e2e-mineracao.mjs` |
| Cadeia de voz (STT/TTS/SSE) | skill **testar-modo-audio** (`npm run test:audio`, gasta API) |
| Prova oral / relay / ending | `RUN_ORAL_E2E=1 node tests/oral-e2e/run.mjs` (~US$0,09) e `node tests/oral-ending-e2e.mjs` |
| Cenários | `node tests/scenario-eval.mjs --max-usd <cap>` (único com teto duro) |
| Benchmark | `npm run bench:validate` (dry-run grátis) → `npm run bench` |
| Schema | `npm run db:migrate -- status` antes/depois; testar rehidratação de sessão |

Regra: harness que gasta API roda com parcimônia e SEMPRE informando o
usuário do custo antes.

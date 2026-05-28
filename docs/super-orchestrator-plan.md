# Plano: super-orquestrador LLM

Documento vivo. Branch: `experiment/super-orquestrador`. Origem da discussão: a
constatação de que o sistema atual tem orçamento de latência disponível ("vale
a LLM pensar mais"), que muitos casos de borda não são tratáveis no design
atual (ex.: aluno querer retomar pergunta anterior), e que a orquestração na
mão do código está obrigando o time a virar babá da LLM.

## Objetivo

Substituir a orquestração por código (triagem ×3 + sufficiency + relevance +
composição da pergunta) por **uma única chamada de raciocínio por turno** que
recebe contexto completo e devolve a próxima ação. O código vira despachante
de ações, não autor de decisão.

## Como muda

### Hoje (per turno do aluno, modo áudio):

```
STT → pré-gate inteligibilidade (algoritmo + AudioIntelligibilityAgent se gateado)
    → triagem ×3 fast em paralelo (Scope, OffTopic, Meta)
    → AnswerSufficiency (reasoning, abortável)
    → pickTriageWinner OU follow_up OU accept
    → QuestionRelevance (loop de skip)
    → compõe próxima pergunta + transition_phrase
    → TTS
```

5 a 7 chamadas LLM por turno. Cada agente é especializado, com schema
próprio. O código sabe quem chamar quando, é o orquestrador.

### Novo:

```
STT → pré-gate inteligibilidade (mantém — algoritmo + AudioIntelligibilityAgent)
    → SuperOrquestradorAgent (1 reasoning call, contexto cheio)
    → despacha a ação retornada
    → TTS
```

1 chamada principal de raciocínio. O super-orquestrador decide tudo: avançar,
follow_up, modal de meta, dica, finalizar, ou até retomar um turno anterior.

### Pré-interview (no `/upload`):

Hoje: `MapBuilderAgent` (DocumentMap) + `PlanBuilderAgent` (10 perguntas) em
paralelo, com structured outputs separados.

Novo: **PrepBuilderAgent** com duas chamadas serializadas (a segunda lê o
output da primeira):

1. **Análise do trabalho** — JSON com `summary`, `assessment` (forças,
   fraquezas, pontos críticos, dúvidas sobre autoria), `evidence_index`
   (pontos do PDF do aluno que são candidatos a serem cobrados).
2. **Plano de entrevista** — JSON com 10 perguntas, cada uma com `rationale`,
   `objectives`/`concerns`/`decision_criteria`/`information_needs`/`evaluation_mode`
   (mesma estrutura de hoje, herdada do plano atual). Recebe a análise como
   contexto.

Por que 2 e não 1: a chamada única ficaria muito longa de saída, e o plano
de perguntas se beneficia do raciocínio sobre a análise. Por que não 3: a
divisão summary/assessment não justifica chamada separada.

## Contrato — schema da ação

Esta é a peça mais crítica do desenho. **Tudo orbita esse JSON.**

O campo `rationale` é **obrigatório em toda ação**. É a justificativa que
o professor vê no log (mesmo papel que o `rationale` que hoje cada pergunta
do plano tem em [config/interview_prompt_template.txt](../config/interview_prompt_template.txt)).
Modelos de reasoning fazem chain-of-thought interno e não preciso de campo
separado para isso — o `rationale` é o produto auditável, não a esteira.

Em `ask`, a justificativa vem acompanhada da associação a itens do YAML
(`objectives`, `concerns`, etc.) — mesma estrutura de hoje, para que o
professor reconheça o formato e a auditoria continue funcionando.

```jsonc
{
  "rationale": "OBRIGATÓRIO. Justifica o porquê desta ação. Vai pro log do professor.",

  "action": {
    "kind": "ask" | "follow_up" | "meta_modal" | "hint" | "finalize" | "ask_repeat",

    // OBRIGATÓRIO para ask | follow_up | meta_modal | finalize | ask_repeat
    "message": "fala em voz da persona (vai pro aluno via TTS)",

    // Só em ask: qual pergunta do plano está sendo feita (null se for
    // espontânea — ex.: retomar um tópico anterior fora do plano).
    "plan_question_id": 5,
    "revisit_topic": null,           // se a ask retoma um tópico anterior

    // Só em ask: associação aos itens do YAML do entrevistador. Mesma
    // estrutura dos question_metadata atuais (lib/conversationUtils.js#turnFromPlanQuestion).
    // Para perguntas espontâneas (não do plano), arrays vazios são aceitos
    // — o `rationale` carrega o porquê.
    "objectives": ["..."],
    "concerns": ["..."],
    "decision_criteria": ["..."],
    "information_needs": ["..."],
    "evaluation_mode": ["..."],

    // Só em follow_up: a qual turno se refere o follow-up.
    "about_turn_index": 3,
    "follow_up_reason": "incoherence" | "incomplete" | "diminishing_returns",

    // Só em hint: o conteúdo do balão fora do roleplay.
    "hint": {
      "title": "...",
      "body": "..."
    },

    // Só em finalize: motivo (auditoria).
    "finalize_reason": "plan_exhausted" | "diminishing_returns_overall" | "student_disengaged"
  },

  // Estado interno que o orquestrador quer persistir para o próximo turno.
  // Vai como input do próximo turno também (memória explícita do agente,
  // separada do conversation log).
  "memory": {
    "questions_covered": [1, 2, 5],         // ids do plano já respondidos satisfatoriamente
    "questions_skipped": [3],                // ids descartados (substituem QuestionRelevance)
    "open_threads": ["ponto X ainda não cobrado"],
    "free_notes": "qualquer coisa que o agente queira lembrar"
  }
}
```

O campo `memory` é a inovação: o agente carrega seu próprio bloco de notas
de turno para turno. Substitui várias estruturas hoje espalhadas (skipped
questions, intervention logs, follow-up counters).

## Guardrails (código, não LLM)

- **`MAX_TURNS = 30`**: depois disso, o despachante força `finalize`
  independente do que o agente retornar.
- **Finalização precoce bloqueada**: não aceita `finalize` antes de N turnos
  respondidos (digamos 5), exceto se `kind=finalize` E `finalize_reason=student_disengaged`.
- **Schema validation**: se o JSON não conformar, fallback para `ask_repeat`
  com mensagem genérica + log para diagnóstico.
- **Pré-gate de áudio continua existindo** (algoritmo sobre logprobs, depois
  AudioIntelligibilityAgent para fraseiar). Roda ANTES do super-orquestrador.
  Áudio ininteligível nunca chega ao super-orquestrador.
- **Timeout** na chamada do super-orquestrador (digamos 25s); se estourar,
  fallback "estou pensando, dê um momento — pode repetir a última?" e tenta
  no próximo turno.

## Estrutura do prompt e cache

Ordem importa — modelos recentes da OpenAI dão desconto automático em prefixos
repetidos. Tudo que é estável vai no começo:

```
[SYSTEM PROMPT — STATIC global]
[INTERVIEWER YAML renderizado — STATIC por trabalho]
[ANÁLISE DO TRABALHO — STATIC após upload]
[PLANO DE PERGUNTAS — STATIC após upload]
[MEMORY do agente — varia entre turnos, MAS pequeno]
[HISTÓRICO DA CONVERSA — cresce, mas é o que muda]
[ÚLTIMA MENSAGEM DO ALUNO — novo a cada turno]
[INSTRUÇÃO: produza a próxima ação no schema X]
```

A janela cacheável fica entre o system prompt e o final da análise+plano. Em
turnos sucessivos, essa parte é desconto. O histórico cresce ~500 tokens por
turno; em 30 turnos chega a ~15K tokens. Reasoning models lidam confortavelmente.

## Tools

- `file_search` sobre vector store com **múltiplos documentos**:
  - **PDF do aluno** (já hoje, [lib/sessionLifecycle.js#createVectorStoreWithFile](../lib/sessionLifecycle.js)).
  - **PDF do enunciado** (novo). Útil para o agente verificar "o que foi
    pedido vs o que foi entregue" diretamente, em vez de depender só do
    YAML do entrevistador.
  - **Slot extensível** (FUTURO, fora desta branch): material da disciplina
    associado ao trabalho. Quando esse dia chegar vai precisar de migration
    para algo tipo `works.knowledge_docs` (tabela de muitos). Por ora o
    desenho vetoriza N documentos por sessão, mas só o enunciado e o aluno
    são alimentados; a infraestrutura aceita o terceiro sem refatoração.

A função que cria a vector store passa a aceitar `[fileId]` → `Array<fileId>`,
mudança pequena no caller (createVectorStoreWithFile).

## Persistência (zero migrations)

**Regra dura: nenhuma coluna nova.** Tudo dentro de `runtime_state_json`
(JSONB). Se o experimento for abandonado, descartar o branch resolve.

Novos campos em `runtime_state_json`:
```
{
  ...                                  // campos existentes intocados
  super_orchestrator: {
    version: 1,                        // schema do bloco
    work_analysis: { ... },            // JSON da chamada 1 do PrepBuilder
    interview_plan: { questions: [...] }, // JSON da chamada 2 (já existe hoje, aproveita)
    memory: { ... }                    // bloco que o agente carrega de turno em turno
  }
}
```

`interview_plan` já vive em `runtime_state.interview_plan` hoje — fica onde
está, só substituído quem produz.

O `conversation_json` (log visível ao professor) ganha por turno:
```
{
  ...
  action_kind: "ask" | "follow_up" | ...,  // auditoria
  super_thinking: "...",                    // o thinking do agente, só visível ao prof
}
```

## O que sai, o que fica

**Sai (no branch):**
- `ScopeClarificationAgent`
- `OffTopicRedirectAgent`
- `MetaInterventionAgent`
- `AnswerSufficiencyAgent`
- `QuestionRelevanceAgent`
- `lib/triage.js` (pickTriageWinner)
- `MapBuilderAgent` (absorvido no PrepBuilder)
- `PlanBuilderAgent` (idem)

**Fica:**
- `IntroductionAgent` — intro de 3 falas (ask_name → present_self → begin)
  é especializada e determinística. Mantém. O super-orquestrador assume só
  na fase `interviewing`.
- `AudioIntelligibilityAgent` + detector algorítmico — pré-gate de áudio
  ortogonal, roda antes.
- `EnunciadoCoherenceAgent` e `ConfigAssistantAgent` — não tocam na entrevista,
  são professor-facing. Intocados.
- Toda a infraestrutura de finalize, bloqueio, comentário, persona configurável,
  Dica, modal de meta etc.

## Agentes paralelos auxiliares (FUTURO — não nesta versão)

Você mencionou a possibilidade de, no futuro, ter agentes paralelos observando
a conversa para aspectos específicos e injetando conclusões no super-prompt
("prompt-injection do bem"). A arquitetura acomoda isso: esses observers
escreveriam em um sub-bloco do `memory`, lido pelo super-orquestrador no turno
seguinte. **Fora de escopo agora**, mas o desenho não fecha a porta.

## Fases da implementação

1. **Andaime sem mudança de comportamento.**
   - Definir o schema da ação em `lib/superOrchestrator/actionSchema.js`.
   - Stub do `SuperOrchestratorAgent` (chama mas devolve um `ask` constante).
   - Stub do `PrepBuilderAgent`.
   - Doc da action schema neste arquivo (acima).

2. **Pré-interview.**
   - Substituir `MapBuilderAgent` + `PlanBuilderAgent` no `/upload` por
     `PrepBuilderAgent` (2 chamadas).
   - Persistir os JSONs em `runtime_state.super_orchestrator`.
   - Manter `interview_plan` no caminho antigo para o frontend e
     `conversation.html` continuarem funcionando (mesmo shape).

3. **Per-turn — só na fase `interviewing`.**
   - No `/chat`, após pré-gate de áudio, se `currentPhase === "interviewing"`:
     - Chamar `SuperOrchestratorAgent` com contexto cheio.
     - Despachar `action.kind`:
       - `ask` → cria novo turno, persiste, TTS, devolve.
       - `follow_up` → empurra intervenção no turno corrente, TTS, devolve.
       - `meta_modal` → resposta com `channel: "modal"` (frontend abre dialog).
       - `hint` → resposta com `audio_intelligibility.hint`-like payload (frontend
         renderiza Dica) + fala da persona.
       - `finalize` → seta `phase = "finalizing"`, fala de encerramento, frontend
         mostra formulário de comentário.
       - `ask_repeat` → fallback genérico (usado quando schema vem inválido).
     - Atualizar `sess.superOrchestrator.memory` com o `memory` retornado.

4. **Intro intocada** — `IntroductionAgent` (3 beats) segue.

5. **Logging detalhado por chamada.**
   - Início/fim do PrepBuilder, com latência e tamanho.
   - Início/fim do SuperOrquestrador, com `action.kind` e latência.
   - Tudo gravado em log para iterar calibração depois.

6. **Feature flag em `policy.yaml`** (opcional mas útil):
   ```yaml
   orchestrator:
     mode: "super" | "legacy"   # default "legacy" para coexistirem
   ```
   Permite testar com um aluno na nova arquitetura sem virar tudo de uma vez.
   Se essa flag não for adotada, o branch simplesmente substitui tudo.

7. **Cap duro de turnos + finalize gate** no despachante.

## Latência e custo

**Latência por turno (estimativa, calibrar com dados reais):**
- Hoje: 4-5 calls. Mediana ~6-10s, cauda 15-20s. Dominada por sufficiency.
- Novo: 1 reasoning call com contexto maior. Mediana provavelmente similar
  (~6-12s); cauda pode ser pior (15-25s) por causa de chain-of-thought interno
  com mais material. **Mitigação:** o balão "ouvindo/respondendo" que acabamos
  de calibrar tolera bem. Mas vale instrumentar.

**Custo por turno (estimativa grosseira):**
- Hoje: 4 fast (~$0.001 cada) + 1 reasoning (~$0.02) ≈ $0.025.
- Novo: 1 reasoning com mais tokens de input (~$0.04-0.06). Com prompt
  caching desconta o prefixo estável (provavelmente 30-50%). Saldo: ~1.5-2.5×
  o custo atual por turno.
- Entrevista de 20 turnos: ~$0.50-$1.00 vs ~$0.50 hoje. Aceitável.

## Riscos e mitigações

| Risco | Severidade | Mitigação |
|---|---|---|
| Action JSON malformado | médio | validação + fallback `ask_repeat` + log para auditoria |
| Agente nunca finaliza | alto | `MAX_TURNS = 30` força finalize |
| Agente finaliza cedo demais | médio | bloqueia `finalize` antes de N turnos respondidos |
| Latência cauda longa (>25s) | médio | timeout + fallback, instrumentação para iterar |
| Custo subiu demais | baixo | budget check existente já cobre; vale monitorar |
| Contexto cresce demais em entrevistas longas | médio | resumir histórico antigo após 25 turnos (out of scope inicial) |
| Inconsistência de comportamento entre turnos | médio | memory bloco ajuda; iterar prompt; observability |
| Branch abandonado deixa lixo | mitigado | zero migrations, tudo em JSONB, descartar branch resolve |

## Decisões pendentes

1. ~~Feature flag legacy vs super~~ → **decidido: sem flag**. O branch
   substitui completamente; A/B controlado, se desejado, vai por deploy
   (uma instância na main, outra no branch). Evita duplicar código no
   `routes/interview.js`.
2. ~~Onde mora o thinking do agente~~ → **decidido: `rationale` obrigatório
   por ação, sempre visível ao professor** (no log, mesmo papel que o
   `rationale` das perguntas hoje). `thinking` dropado do schema — modelos
   de reasoning fazem chain-of-thought interno e o que importa é a
   justificativa final.
3. **Limite de tamanho do histórico:** ignorar até 30 turnos e depois resumir?
   Ou crescer indefinidamente até estourar contexto? (Hoje cap natural é 10
   perguntas; com super-orquestrador podendo gerar follow-ups e revisitas,
   pode passar muito mais.)
4. ~~PDF do enunciado também via vector store~~ → **decidido: sim**.
   Acrescentado também o slot extensível para material da disciplina (FUTURO,
   fora desta branch — vai exigir migration de schema).

---

## Próximos passos quando aprovado

1. Commitar este doc.
2. Implementar fase 1 (andaime).
3. Implementar fase 2 (PrepBuilder).
4. Implementar fase 3 (per-turn).
5. Testar manualmente em ambos os modos (texto e áudio).
6. Calibrar logs e prompts.
7. Decidir merge.

# Arquitetura — ciclo do `/chat` e mapa de prompts

Diagrama do que acontece entre uma resposta do aluno e a próxima pergunta do plano:
triagem em paralelo (3 agentes), agente de relevância (loop de skip) e progressão.

> **Como abrir os arquivos no clique**
>
> Pré-requisito: extensão **Markdown Preview Mermaid Support** (`bierner.markdown-mermaid`) instalada. Abra esta página com `Ctrl+Shift+V`.
>
> No diagrama, **cada nó de agente clica direto na linha do `systemPrompt`** (não no topo do arquivo). Os nós de fluxo clicam na linha do handler/função correspondente. O nó "Templates compartilhados" clica nos templates `.txt` que entram na composição dos prompts dos agentes de triagem e do de relevância. Se o seu preview bloquear o esquema `vscode://` (alguns o fazem por segurança), use a **tabela de navegação** abaixo do diagrama — links markdown puros que sempre funcionam.

```mermaid
flowchart TD
  Start([Aluno envia mensagem]) --> ChatHandler["server.js — POST /chat"]
  ChatHandler --> CheckPlan{"Plano ainda<br/>tem perguntas?"}
  CheckPlan -- "não" --> Wrap["Mensagem de fechamento<br/>'Obrigado pelas respostas...'"]
  CheckPlan -- "sim" --> TriageStart["Promise.all — triagem em paralelo"]

  TriageStart --> Scope["ScopeClarificationAgent<br/>(prompt)"]
  TriageStart --> OffTopic["OffTopicRedirectAgent<br/>(prompt)"]
  TriageStart --> Meta["MetaInterventionAgent<br/>(prompt)"]

  Scope --> Pick{"argmax(intensity)<br/>≥ TRIAGE_THRESHOLD?"}
  OffTopic --> Pick
  Meta --> Pick

  Pick -- "vencedor channel=chat" --> ChatChannel["Resposta vai pro chat<br/>turno permanece aberto"]
  Pick -- "vencedor channel=modal" --> ModalChannel["Modal pro aluno<br/>mensagem volta ao input,<br/>fora do conv_chat"]
  Pick -- "nenhum acima do threshold" --> RecordAnswer["Grava answer + answered_at<br/>no turno corrente"]

  RecordAnswer --> Relevance["QuestionRelevanceAgent<br/>(prompt) — loop até ask ou cap"]
  Relevance -- "skip" --> SkipLog["push em<br/>sess.skippedQuestions"]
  SkipLog --> Relevance
  Relevance -- "ask" --> NextQ["Empurra novo turno +<br/>envia pergunta candidata"]
  Relevance -- "plano esgotou no skip" --> Wrap

  NextQ --> Persist[("conversation.json")]
  ChatChannel --> Persist
  ModalChannel --> Persist
  Wrap --> Persist

  subgraph templates ["Templates compartilhados (componentes do prompt)"]
    AgendaTpl["interviewer_agenda_template.txt<br/>(agenda renderizada via lib/interviewerAgenda.js)"]
  end

  Scope -.-> AgendaTpl
  OffTopic -.-> AgendaTpl
  Meta -.-> AgendaTpl
  Relevance -.-> AgendaTpl

  classDef link fill:#eaf0f7,stroke:#1e3a5f,color:#0f1b2d;
  classDef sink fill:#e7f4eb,stroke:#1f6c3b,color:#0f1b2d;
  classDef gate fill:#fff4dc,stroke:#8a6100,color:#0f1b2d;
  classDef tpl  fill:#f3f5f8,stroke:#5a6b80,color:#0f1b2d,stroke-dasharray: 4 2;
  class ChatHandler,Scope,OffTopic,Meta,Relevance,RecordAnswer,NextQ,SkipLog,ChatChannel,ModalChannel,TriageStart link
  class Persist,Wrap sink
  class CheckPlan,Pick gate
  class AgendaTpl tpl

  click ChatHandler "vscode://file/c:/Users/glads/src/super-ta/server.js:973" "Abre o handler /chat"
  click TriageStart "vscode://file/c:/Users/glads/src/super-ta/server.js:997" "Abre o bloco de triagem em paralelo"
  click Scope "vscode://file/c:/Users/glads/src/super-ta/agents/ScopeClarificationAgent.js:23" "Abre o systemPrompt do ScopeClarificationAgent"
  click OffTopic "vscode://file/c:/Users/glads/src/super-ta/agents/OffTopicRedirectAgent.js:20" "Abre o systemPrompt do OffTopicRedirectAgent"
  click Meta "vscode://file/c:/Users/glads/src/super-ta/agents/MetaInterventionAgent.js:24" "Abre o systemPrompt do MetaInterventionAgent"
  click Pick "vscode://file/c:/Users/glads/src/super-ta/server.js:273" "Abre pickTriageWinner"
  click RecordAnswer "vscode://file/c:/Users/glads/src/super-ta/server.js:1096" "Abre o ramo normal do /chat"
  click Relevance "vscode://file/c:/Users/glads/src/super-ta/agents/QuestionRelevanceAgent.js:23" "Abre o systemPrompt do QuestionRelevanceAgent"
  click SkipLog "vscode://file/c:/Users/glads/src/super-ta/server.js:1122" "Abre o skip-loop no /chat"
  click NextQ "vscode://file/c:/Users/glads/src/super-ta/server.js:187" "Abre turnFromPlanQuestion"
  click Persist "vscode://file/c:/Users/glads/src/super-ta/lib/conversationLog.js" "Abre conversationLog.js"
  click Wrap "vscode://file/c:/Users/glads/src/super-ta/server.js:1170" "Abre a string da mensagem de fechamento"
  click AgendaTpl "vscode://file/c:/Users/glads/src/super-ta/config/interviewer_agenda_template.txt" "Abre o template da agenda do entrevistador"
```

## Tabela de navegação — código e prompt lado a lado

Use esta tabela se o clique no SVG não abrir nada. Cada linha tem o **bloco de código** e o **prompt** correspondente quando há.

| Bloco | Código | Prompt enviado à LLM |
|---|---|---|
| Handler do `/chat` | [server.js:973](../server.js#L973) | — |
| Triagem em paralelo (`Promise.all`) | [server.js:997](../server.js#L997) | — |
| `ScopeClarificationAgent` | [agents/ScopeClarificationAgent.js](../agents/ScopeClarificationAgent.js) | [systemPrompt :23](../agents/ScopeClarificationAgent.js#L23) + agenda + último turno |
| `OffTopicRedirectAgent` | [agents/OffTopicRedirectAgent.js](../agents/OffTopicRedirectAgent.js) | [systemPrompt :20](../agents/OffTopicRedirectAgent.js#L20) + agenda + último turno |
| `MetaInterventionAgent` | [agents/MetaInterventionAgent.js](../agents/MetaInterventionAgent.js) | [systemPrompt :24](../agents/MetaInterventionAgent.js#L24) + agenda + último turno |
| Decisão do vencedor (`pickTriageWinner`) | [server.js:273](../server.js#L273) | — |
| Ramo normal sem intervenção | [server.js:1096](../server.js#L1096) | — |
| `QuestionRelevanceAgent` | [agents/QuestionRelevanceAgent.js](../agents/QuestionRelevanceAgent.js) | [systemPrompt :23](../agents/QuestionRelevanceAgent.js#L23) + agenda + conversa completa + candidata |
| Skip-loop de relevância | [server.js:1122](../server.js#L1122) | — |
| `turnFromPlanQuestion` | [server.js:187](../server.js#L187) | — |
| Serializer do log | [server.js:207](../server.js#L207) | — |
| Persistência do log | [lib/conversationLog.js](../lib/conversationLog.js) | — |
| Endpoint que serve o log pro professor | [server.js:592](../server.js#L592) | — |
| Mensagem de fechamento (sentinel) | [server.js:1170](../server.js#L1170) | string literal — não vai à LLM |

## Caminhos não cobertos pelo diagrama

| Bloco | Código | Prompt enviado à LLM |
|---|---|---|
| `/upload` (gera plano de entrevista) | [server.js:847](../server.js#L847) | [interview_prompt_template.txt](../config/interview_prompt_template.txt) renderizado via [lib/interviewPrompt.js](../lib/interviewPrompt.js) |
| `MapBuilderAgent` (chamado em `/upload`) | [agents/MapBuilderAgent.js](../agents/MapBuilderAgent.js) | [systemPrompt :22](../agents/MapBuilderAgent.js#L22) |
| `ComprehensionEvaluatorAgent` (chamado em `/finalize`) | [agents/ComprehensionEvaluatorAgent.js](../agents/ComprehensionEvaluatorAgent.js) | [systemPrompt :23](../agents/ComprehensionEvaluatorAgent.js#L23) |
| `ClarificationEvaluatorAgent` (chamado em `/finalize`) | [agents/ClarificationEvaluatorAgent.js](../agents/ClarificationEvaluatorAgent.js) | [systemPrompt :23](../agents/ClarificationEvaluatorAgent.js#L23) |
| `INTERVIEWER_ADAPT_INSTRUCTIONS` (botão "Adaptar ao enunciado") | [server.js:660](../server.js#L660) | string literal usada como `instructions` na chamada da Responses API |
| Base TA (carregada por `loadSystemPrompt`) | [server.js:88](../server.js#L88) | [config/system_prompt.txt](../config/system_prompt.txt) |
| `/finalize` (gera relatório) | [server.js:1192](../server.js#L1192) | strings inline na função `calculateRubricScores` (a ser extraídas, ver TODO abaixo) |

## Índice completo de prompts

Lugar único onde encontrar **todo prompt enviado à LLM** no sistema:

1. **Templates `.txt`** ([config/](../config/)):
   - [system_prompt.txt](../config/system_prompt.txt) — base TA.
   - [interview_prompt_template.txt](../config/interview_prompt_template.txt) — geração do plano de entrevista (em `/upload`).
   - [interviewer_agenda_template.txt](../config/interviewer_agenda_template.txt) — bloco de agenda compartilhado por triagem e relevância.
2. **`systemPrompt` em classes de agente** ([agents/](../agents/)):
   - [MapBuilderAgent.js#L22](../agents/MapBuilderAgent.js#L22)
   - [ComprehensionEvaluatorAgent.js#L23](../agents/ComprehensionEvaluatorAgent.js#L23)
   - [ClarificationEvaluatorAgent.js#L23](../agents/ClarificationEvaluatorAgent.js#L23)
   - [ScopeClarificationAgent.js#L23](../agents/ScopeClarificationAgent.js#L23)
   - [OffTopicRedirectAgent.js#L20](../agents/OffTopicRedirectAgent.js#L20)
   - [MetaInterventionAgent.js#L24](../agents/MetaInterventionAgent.js#L24)
   - [QuestionRelevanceAgent.js#L23](../agents/QuestionRelevanceAgent.js#L23)
3. **Strings inline em `server.js`**:
   - [INTERVIEWER_ADAPT_INSTRUCTIONS — linha 660](../server.js#L660) — instruções para "Adaptar ao enunciado".
   - **TODO**: as instruções de C2/C3 dentro de `calculateRubricScores` ainda são strings inline. Quando extraídas para um arquivo dedicado, atualizar este índice.

## Convenção do esquema `vscode://`

Formato no Windows:

```
vscode://file/<drive>:/<caminho-com-barras-pra-frente>:<linha>
```

Exemplo: `vscode://file/c:/Users/glads/src/super-ta/server.js:973`. Sem `:linha` no final, abre na linha 1.

#Contexto arquitetural e features
Leia o @replit.md para uma visão geral arquitetural e das features do sistema

Diretriz permanente:
- evite fallback arquitetural e hierarquia de opções de configuração quando isso obscurecer o comportamento do sistema;
- para seleção de modelo, use apenas `config/policy.yaml` como fonte de verdade;
- se uma configuração obrigatória estiver ausente, prefira falhar explicitamente.

Convenções de prompt para agentes:
- YAMLs de configuração (hoje o `interviewer.yaml`; no futuro outros) nunca vão ao LLM crus. Sempre rodam por um template que explica o significado de cada campo. Veja `config/interviewer_agenda_template.txt` + `lib/interviewerAgenda.js`.
- Qualquer agente novo que precise da agenda do entrevistador usa `renderInterviewerAgenda(yamlText)`. Não recrie a estrutura.
- Contexto de conversa curto e bem-delimitado (ex.: turno corrente + intervenções) vem do estado local em `SESSIONS` (`sess.turnLog`), não da Conversations API. O parâmetro `conversation:` das Responses polui o `conv_chat` remoto com turnos internos; evite.

Mapa de prompts — regra permanente:
- Todo prompt enviado à LLM deve ser alcançável a partir do diagrama em `docs/architecture.md`. Sem exceção.
- Quando criar/mover/renomear um prompt (seja `systemPrompt` em agente, template `.txt` em `config/` ou string inline em `server.js`), atualize na mesma mudança:
  (a) o `click` do nó correspondente no diagrama Mermaid de `docs/architecture.md`,
  (b) a coluna "Prompt enviado à LLM" da tabela de navegação do mesmo arquivo, e
  (c) o "Índice completo de prompts" na mesma página.
- Ao adicionar um agente novo: incluir o nó no diagrama com `click` apontando para a linha do `systemPrompt` (não para o topo do arquivo), e listar o agente no índice.
- Strings inline de prompt em `server.js` são toleradas, mas devem aparecer no índice com link `arquivo#Llinha`. Se virarem mais que duas-três linhas, prefira extrair para arquivo dedicado em `config/` e linkar o `.txt`.
- O diagrama é o ponto único de descoberta. Não criar índices paralelos em outros docs.

#
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

#
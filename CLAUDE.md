#Contexto arquitetural e features
Leia o @replit.md para uma visão geral arquitetural e das features do sistema

Diretriz permanente:
- evite fallback arquitetural e hierarquia de opções de configuração quando isso obscurecer o comportamento do sistema;
- para seleção de modelo, use apenas `config/policy.yaml` como fonte de verdade;
- se uma configuração obrigatória estiver ausente, prefira falhar explicitamente.

#
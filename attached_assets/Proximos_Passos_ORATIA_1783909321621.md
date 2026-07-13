# Próximos passos do ORATIA

## 1. Experiência do professor (prioridade alta)

-   Validar automaticamente o enunciado enviado pelo professor
    -   Detectar quando o documento não é um enunciado de trabalho.
    -   Explicar o problema encontrado.
    -   Sugerir correções antes da publicação.
-   Permitir upload do material da disciplina
    -   Notas de aula.
    -   Slides.
    -   Bibliografia.
    -   Outros materiais de apoio.
-   Gerar automaticamente atividades a partir do material
    -   Sugestão de trabalhos.
    -   Sugestão de entrevistas.
    -   Sugestão de provas orais.
    -   Evoluir para um assistente de planejamento da disciplina.

## 2. Modelo institucional

-   Implementar estrutura organizacional
    -   Instituições.
    -   Unidades.
    -   Subunidades.
    -   Turmas.
-   Implementar papéis
    -   Administrador global.
    -   Administrador de unidade.
    -   Professor.
    -   Funcionário.
    -   Aluno.
-   Implementar hierarquia administrativa
    -   Administrador controla todas as unidades.
    -   Responsáveis por unidade administram suas subunidades.
    -   Possibilidade de delegação de responsabilidade para subunidades.
-   Definir permissões
    -   Professor cria trabalhos.
    -   Funcionário pode criar turmas.
-   Manter a flexibilidade atual
    -   Trabalhos podem existir sem professor associado.
    -   Submissões podem existir sem aluno cadastrado.
-   Implementar controle orçamentário
    -   Por instituição.
    -   Por unidade.
    -   Consolidação para níveis superiores.

## 3. Autenticação

-   Login via Google.
-   Suporte a autenticação federada
    -   Microsoft.
    -   Apple.
    -   Outros provedores.
    -   Login local.

## 4. Interfaces de interação

-   Concluir implementação dos cenários multi-interação.
-   Implementar Real-Time
    -   Entrevistas individuais.
    -   Cenários multi-interação.
-   Integrar vídeo
    -   Entrevistas por mensagens.
    -   Cenários multi-interação.
    -   Entrevistas Real-Time.

## 5. Integração institucional

-   API para integração com sistemas de gestão educacional.
-   Integração com LMS.

## 6. Personalização

-   Customização visual por unidade
    -   Logo.
    -   Paleta de cores.
    -   Layout.

## 7. Custos e modelos de IA

-   Integrar API de pricing da OpenAI.
-   Melhorar controle de custos por unidade.
-   Benchmark de modelos
    -   Qualidade.
    -   Custo.
    -   Tempo de resposta.
    -   Persistência dos resultados.

## 8. Segurança

-   Definir processo de testes de segurança.
-   Implantar infraestrutura de testes.
-   Testar segurança em IA
    -   Prompt injection.
    -   Indirect prompt injection.
    -   Vazamento de contexto.
    -   Escalada de privilégios entre agentes.
-   Testar segurança convencional
    -   Invasão.
    -   DoS.
    -   Abuso de APIs.
    -   Upload malicioso.
    -   Exposição de dados.

## 9. Observabilidade e operação

-   Observabilidade
    -   Logs centralizados.
    -   Rastreamento de fluxos.
    -   Dashboards.
-   Monitoramento
    -   Saúde da aplicação.
    -   Disponibilidade.
    -   Alertas automáticos.

## 10. Qualidade

-   Suíte de testes de regressão
    -   Texto.
    -   Voz.
    -   Imagens (quando possível).
-   Estratégia de regressão automatizada.
-   Avaliação de experiência do usuário (UX).

## 11. Escalabilidade

-   Testes de carga
    -   Entrevistas simultâneas.
    -   Cenários multi-interação.
    -   Concorrência.
-   Avaliar limites da infraestrutura atual.

## 12. Infraestrutura corporativa

-   Migrar contas para organizações corporativas
    -   GitHub.
    -   Replit.
    -   OpenAI.
    -   Outras ferramentas.
-   Planejar migração para infraestrutura corporativa.

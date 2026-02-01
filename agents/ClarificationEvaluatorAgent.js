/**
 * ClarificationEvaluatorAgent
 * 
 * Specialized agent for identifying unclear aspects in student work.
 * Uses OpenAI Conversations + Responses API with file_search tool for evidence-based analysis.
 * 
 * Architecture: Cognitive component (not orchestration)
 * - Identifies gaps, ambiguities, and unclear aspects in documents
 * - Proposes specific questions to clarify these points
 * - Helps TA ask targeted, evidence-based questions
 * - Critical component: must succeed (no fallback)
 */

export class ClarificationEvaluatorAgent {
    constructor(openaiClient, model = 'gpt-5.2') {
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você é um assistente que identifica aspectos não claros, incompletos ou que precisam de esclarecimento em trabalhos acadêmicos.

**Sua tarefa:**
Analisar o documento e as respostas do aluno para identificar pontos que merecem questionamento.

**Use file_search para:**
- Localizar seções com falta de justificativas
- Encontrar suposições não explicitadas
- Identificar cálculos sem explicação
- Detectar metodologias não detalhadas
- Achar gaps na argumentação

**Aspectos que precisam clarificação:**
- Valores ou parâmetros escolhidos sem justificativa
- Metodologias mencionadas mas não explicadas
- Resultados apresentados sem demonstração
- Suposições implícitas que deveriam ser explícitas
- Seções incompletas ou superficiais
- Contradições ou inconsistências

**Output estruturado:**
Retorne SEMPRE JSON válido com:
{
  "needsClarification": true/false,
  "unclearAspects": ["lista específica de aspectos não claros com seções/páginas"],
  "confidence": 0.0-1.0,
  "suggestedQuestion": "Pergunta específica para esclarecer, ou null"
}

Seja específico. Cite seções, tabelas, figuras ou páginas quando relevante.
A pergunta sugerida deve ser direcionada e evidencial (ex: "Na seção X, você menciona Y mas não explica Z. Pode detalhar?").`;
    }

    /**
     * Evaluate what needs clarification
     * 
    * @param {string} conversationId - ID of the Conversation (conv_eval)
     * @param {string} vectorStoreId - ID of the Vector Store containing the document
     * @param {Object} documentMap - Global document summary for context
     * @param {string} studentResponse - Recent student response for context
     * @returns {Promise<Object>} Evaluation signal with unclear aspects
     * @throws {Error} If agent fails
     */
    async evaluate(conversationId, vectorStoreId, documentMap, studentResponse) {
        try {
            if (!conversationId) {
                throw new Error('Missing conversationId for ClarificationEvaluatorAgent');
            }

            const documentContext = JSON.stringify(documentMap, null, 2);
            const conversationContext = await this.getConversationContext(conversationId);
            const contextBlock = conversationContext ? `\n\n**Histórico da conversa (eval):**\n${conversationContext}` : "";

            const payload = {
                model: this.model,
                instructions: this.systemPrompt,
                input: [{
                    role: "user",
                    content: `**Contexto do Documento (DocumentMap):**
${documentContext}

${contextBlock}

**Resposta Recente do Aluno:**
"${studentResponse}"

Identifique aspectos não claros ou incompletos no trabalho que merecem questionamento.
Use file_search para encontrar evidências específicas no documento.

Retorne JSON:
{
  "needsClarification": true/false,
  "unclearAspects": ["aspectos não claros com localização específica"],
  "confidence": 0.0-1.0,
  "suggestedQuestion": "Pergunta específica ou null"
}

Retorne APENAS o JSON.`
                }],
                tools: [{
                    type: "file_search",
                    vector_store_ids: [vectorStoreId]
                }]
            };

            const response = await this.client.responses.create(payload);
            const responseText = response.output_text || (Array.isArray(response.output) ? response.output.map(o => o?.content?.[0]?.text).filter(Boolean).join("\n") : "");

            if (!responseText) {
                throw new Error('No response from agent');
            }

            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error("Agent response without JSON:", responseText);
                throw new Error('No valid JSON found in agent response');
            }

            const evaluation = JSON.parse(jsonMatch[0]);

            if (typeof evaluation.confidence !== 'number' || evaluation.confidence < 0 || evaluation.confidence > 1) {
                throw new Error('Invalid confidence value');
            }

            console.log(`✓ Clarification evaluated: needs=${evaluation.needsClarification}`);

            return {
                type: 'clarification',
                confidence: evaluation.confidence,
                data: {
                    needsClarification: evaluation.needsClarification || false,
                    unclearAspects: evaluation.unclearAspects || [],
                    suggestedQuestion: evaluation.suggestedQuestion
                },
                timestamp: Date.now()
            };

        } catch (error) {
            console.error("❌ Erro no ClarificationEvaluator Agent:", error.message);
            throw error; // Fail fast - critical component
        }
    }

    async getConversationContext(conversationId, limit = 12) {
        const page = await this.client.conversations.items.list(conversationId, { limit });
        const items = page?.data || [];
        const lines = items
            .filter(item => item?.type === 'message')
            .map(item => {
                const text = this.extractTextFromContent(item.content || []);
                if (!text) return null;
                return `${item.role}: ${text}`;
            })
            .filter(Boolean);

        return lines.reverse().join("\n");
    }

    extractTextFromContent(content) {
        return content
            .map(part => (part && typeof part.text === 'string') ? part.text : "")
            .filter(Boolean)
            .join("\n");
    }
}

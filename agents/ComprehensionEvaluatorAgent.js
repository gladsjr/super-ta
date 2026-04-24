/**
 * ComprehensionEvaluatorAgent
 * 
 * Specialized agent for evaluating student comprehension of their own work.
 * Uses OpenAI Conversations + Responses API with file_search tool for evidence-based evaluation.
 * 
 * Architecture: Cognitive component (not orchestration)
 * - Analyzes student responses against document content
 * - Generates signals with confidence scores and evidence
 * - Maps to Rubric C1 (40% weight): Comprehension of own work
 * - Critical component: must succeed (no fallback)
 */

import log from "../lib/logger.js";

export class ComprehensionEvaluatorAgent {
    constructor(openaiClient, model) {
        if (!model) {
            throw new Error('Missing model for ComprehensionEvaluatorAgent');
        }
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você é um avaliador especializado em verificar se estudantes genuinamente compreendem seus próprios trabalhos.

**Critério de Avaliação (C1 - 40% do peso total):**
Compreensão do conteúdo do próprio trabalho entregue.

**Sua tarefa:**
Analisar as respostas do aluno e avaliar se demonstram compreensão genuína do trabalho submetido.

**Use file_search para:**
- Verificar se o aluno conhece o conteúdo específico do documento
- Identificar inconsistências entre o que o aluno diz e o que está escrito
- Encontrar evidências de compreensão ou falta dela

**Sinais de NÃO-compreensão (red flags):**
- Respostas vagas ou genéricas que não referenciam o trabalho específico
- Contradições com o conteúdo do documento
- Incapacidade de explicar escolhas feitas no trabalho
- Respostas que sugerem que outra pessoa fez o trabalho
- Falta de familiaridade com seções ou cálculos específicos

**Output estruturado:**
Retorne SEMPRE JSON válido com:
{
  "understands": true/false,
  "confidence": 0.0-1.0,
  "evidence": "Justificativa baseada em evidências do documento e resposta",
  "redFlags": ["lista de sinais específicos de não-compreensão"],
  "suggestedFollowUp": "Pergunta de follow-up para aprofundar, ou null"
}

Seja criterioso mas justo. Use citações do documento quando relevante.`;
    }

    /**
     * Evaluate student comprehension
     * 
    * @param {string} conversationId - ID of the Conversation (conv_eval)
     * @param {string} vectorStoreId - ID of the Vector Store containing the document
     * @param {Object} documentMap - Global document summary for context
     * @param {string} studentResponse - Student's response to evaluate
     * @returns {Promise<Object>} Evaluation signal with confidence and evidence
     * @throws {Error} If agent fails
     */
    async evaluate(conversationId, vectorStoreId, documentMap, studentResponse) {
        try {
            if (!conversationId) {
                throw new Error('Missing conversationId for ComprehensionEvaluatorAgent');
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

**Resposta do Aluno:**
"${studentResponse}"

Avalie se o aluno demonstra compreensão genuína do trabalho.
Use file_search para buscar evidências no documento original.

Retorne JSON:
{
  "understands": true/false,
  "confidence": 0.0-1.0,
  "evidence": "Justificativa com evidências",
  "redFlags": ["sinais de não-compreensão"],
  "suggestedFollowUp": "Pergunta ou null"
}

Retorne APENAS o JSON.`
                }],
                tools: [{
                    type: "file_search",
                    vector_store_ids: [vectorStoreId]
                }]
            };

            log.prompt("AGENT:Comprehension", this.systemPrompt + "\n\n" + payload.input[0].content);
            const response = await log.span("AGENT:Comprehension", "responses.create", () =>
                this.client.responses.create(payload)
            );
            const responseText = response.output_text || (Array.isArray(response.output) ? response.output.map(o => o?.content?.[0]?.text).filter(Boolean).join("\n") : "");

            if (!responseText) {
                throw new Error('No response from agent');
            }

            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                log.error("AGENT:Comprehension", `response without JSON: ${log.preview(responseText, 200)}`);
                throw new Error('No valid JSON found in agent response');
            }

            const evaluation = JSON.parse(jsonMatch[0]);

            if (typeof evaluation.confidence !== 'number' || evaluation.confidence < 0 || evaluation.confidence > 1) {
                throw new Error('Invalid confidence value');
            }

            const redFlagCount = Array.isArray(evaluation.redFlags) ? evaluation.redFlags.length : 0;
            log.info("AGENT:Comprehension", `ok confidence=${evaluation.confidence} understands=${!!evaluation.understands} redFlags=${redFlagCount}`);

            return {
                type: 'comprehension',
                confidence: evaluation.confidence,
                data: {
                    understands: evaluation.understands || false,
                    evidence: evaluation.evidence || "",
                    redFlags: evaluation.redFlags || [],
                    suggestedFollowUp: evaluation.suggestedFollowUp
                },
                timestamp: Date.now()
            };

        } catch (error) {
            log.error("AGENT:Comprehension", `failed: ${error.message}`);
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

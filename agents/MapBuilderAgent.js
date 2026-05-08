/**
 * MapBuilderAgent
 * 
 * Specialized agent for analyzing documents and generating structured DocumentMap.
 * Uses OpenAI Responses API with the full document attached as input.
 * 
 * Architecture: Cognitive component (not orchestration)
 * - Provides structured analysis of student documents
 * - Identifies thesis, structure, methodology, claims, and weak points
 * - Critical component: must succeed (no fallback)
 */

import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";

export class MapBuilderAgent {
    constructor(openaiClient, model) {
        if (!model) {
            throw new Error('Missing model for MapBuilderAgent');
        }
        this.client = openaiClient;
        this.model = model;
        this.systemPrompt = `Você é um especialista em análise estruturada de documentos acadêmicos e técnicos.

Sua tarefa é analisar documentos e extrair um mapa estruturado com:

1. **thesis**: O objetivo ou tese principal do trabalho (1 frase concisa)
2. **structure**: Lista das seções principais encontradas no documento
3. **methodology**: Metodologia ou abordagem utilizada (1-2 frases)
4. **keyClaims**: 2-4 principais afirmações, resultados ou conclusões
5. **weakPoints**: 1-3 pontos fracos, incompletos, ambíguos ou que merecem questionamento

Seja crítico ao identificar weakPoints - procure por:
- Falta de justificativas para valores escolhidos
- Análises incompletas (falta de sensibilidade, riscos, etc)
- Suposições não explicitadas
- Gaps metodológicos
- Inconsistências entre seções
- Cálculos ou raciocínios que precisam de clarificação

Use o conteúdo completo do documento para buscar evidências específicas.
Cite seções, tabelas ou figuras quando relevante.

Retorne SEMPRE JSON válido no formato especificado.`;
    }

    /**
     * Generate DocumentMap using the agent
     * 
     * @param {string} conversationId - ID of the Conversation (required)
     * @param {string} openaiFileId - OpenAI File ID for the full document
     * @returns {Promise<Object>} DocumentMap with validated structure
     * @throws {Error} If agent fails or returns invalid structure
     */
    async generateDocumentMap(conversationId, openaiFileId, meterCtx = null) {
        try {
            if (!conversationId) {
                throw new Error('Missing conversationId for MapBuilderAgent');
            }

            if (!openaiFileId) {
                throw new Error('Missing openaiFileId for MapBuilderAgent');
            }

            const conversationContext = await this.getConversationContext(conversationId);
            const contextBlock = conversationContext ? `\n\n**Contexto da conversa (eval):**\n${conversationContext}` : "";

            const payload = {
                model: this.model,
                instructions: this.systemPrompt,
                input: [{
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: `Analise o documento completo (anexo) e retorne um JSON estruturado com:

{
  "thesis": "objetivo/tese principal do trabalho",
  "structure": ["seção 1", "seção 2", ...],
  "methodology": "metodologia ou abordagem utilizada",
  "keyClaims": ["claim 1", "claim 2", ...],
  "weakPoints": ["ponto fraco 1", "ponto fraco 2", ...]
}

Use exclusivamente o conteúdo do documento anexado como base.
Retorne APENAS o JSON, sem markdown ou texto adicional.${contextBlock}`
                        },
                        { type: "input_file", file_id: openaiFileId }
                    ]
                }]
            };

            log.prompt("AGENT:MapBuilder", this.systemPrompt + "\n\n" + payload.input[0].content[0].text);
            const response = await log.span("AGENT:MapBuilder", "responses.create", () =>
                meteredResponses(
                    { ...meterCtx, agentLabel: "AGENT:MapBuilder", model: this.model },
                    () => this.client.responses.create(payload)
                )
            );

            const responseText = response.output_text || (Array.isArray(response.output) ? response.output.map(o => o?.content?.[0]?.text).filter(Boolean).join("\n") : "");

            if (!responseText) {
                throw new Error('No response from agent');
            }

            // Extract JSON from response (handles markdown code blocks)
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                log.error("AGENT:MapBuilder", `response without JSON: ${log.preview(responseText, 200)}`);
                throw new Error('No valid JSON found in agent response');
            }

            const documentMap = JSON.parse(jsonMatch[0]);

            // Validate required structure
            const requiredFields = ['thesis', 'structure', 'methodology', 'keyClaims', 'weakPoints'];
            const missingFields = requiredFields.filter(field => !documentMap[field]);

            if (missingFields.length > 0) {
                throw new Error(`Invalid DocumentMap: missing fields ${missingFields.join(', ')}`);
            }

            // Validate types
            if (!Array.isArray(documentMap.structure) || !Array.isArray(documentMap.keyClaims) || !Array.isArray(documentMap.weakPoints)) {
                throw new Error('Invalid DocumentMap: structure, keyClaims, and weakPoints must be arrays');
            }

            log.info("AGENT:MapBuilder", `ok thesis=${log.preview(documentMap.thesis, 80)} structure=${documentMap.structure.length} claims=${documentMap.keyClaims.length} weak=${documentMap.weakPoints.length}`);
            if (log.enabled("debug")) {
                log.debug("AGENT:MapBuilder", `DocumentMap JSON:\n${JSON.stringify(documentMap, null, 2)}`);
            }
            return documentMap;

        } catch (error) {
            log.error("AGENT:MapBuilder", `failed: ${error.message}`);
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

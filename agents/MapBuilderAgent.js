/**
 * MapBuilderAgent
 * 
 * Specialized agent for analyzing documents and generating structured DocumentMap.
 * Uses OpenAI Assistants API with file_search tool for deep document understanding.
 * 
 * Architecture: Cognitive component (not orchestration)
 * - Provides structured analysis of student documents
 * - Identifies thesis, structure, methodology, claims, and weak points
 * - Critical component: must succeed (no fallback)
 */

export class MapBuilderAgent {
    constructor(openaiClient, model = 'gpt-5.2') {
        this.client = openaiClient;
        this.model = model;
        this.agentId = null;
    }

    /**
     * Create or retrieve the MapBuilder agent
     */
    async initialize() {
        if (this.agentId) return this.agentId;

        try {
            const agent = await this.client.beta.assistants.create({
                name: "MapBuilder",
                instructions: `Você é um especialista em análise estruturada de documentos acadêmicos e técnicos.

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

Use o tool file_search para buscar evidências específicas no documento.
Cite seções, tabelas ou figuras quando relevante.

Retorne SEMPRE JSON válido no formato especificado.`,
                model: this.model,
                tools: [{ type: "file_search" }]
            });

            this.agentId = agent.id;
            console.log(`✓ MapBuilder Agent criado: ${this.agentId} (modelo: ${this.model})`);
            return this.agentId;
        } catch (error) {
            console.error("❌ Erro ao criar MapBuilder Agent:", error);
            throw error;
        }
    }

    /**
     * Generate DocumentMap using the agent
     * 
     * @param {string} vectorStoreId - ID of the Vector Store containing the document
     * @returns {Promise<Object>} DocumentMap with validated structure
     * @throws {Error} If agent fails or returns invalid structure
     */
    async generateDocumentMap(vectorStoreId) {
        await this.initialize();

        try {
            // Create a thread with the vector store attached
            const thread = await this.client.beta.threads.create({
                tool_resources: {
                    file_search: { vector_store_ids: [vectorStoreId] }
                }
            });

            // Add user message requesting analysis
            await this.client.beta.threads.messages.create(thread.id, {
                role: "user",
                content: `Analise o documento em profundidade e retorne um JSON estruturado com:

{
  "thesis": "objetivo/tese principal do trabalho",
  "structure": ["seção 1", "seção 2", ...],
  "methodology": "metodologia ou abordagem utilizada",
  "keyClaims": ["claim 1", "claim 2", ...],
  "weakPoints": ["ponto fraco 1", "ponto fraco 2", ...]
}

Use file_search para buscar evidências específicas.
Retorne APENAS o JSON, sem markdown ou texto adicional.`
            });

            // Run the agent
            const run = await this.client.beta.threads.runs.createAndPoll(thread.id, {
                assistant_id: this.agentId
            });

            if (run.status !== 'completed') {
                throw new Error(`Agent run failed with status: ${run.status}`);
            }

            // Retrieve the response
            const messages = await this.client.beta.threads.messages.list(thread.id);
            const assistantMessage = messages.data.find(m => m.role === 'assistant');

            if (!assistantMessage || !assistantMessage.content[0]) {
                throw new Error('No response from agent');
            }

            const responseText = assistantMessage.content[0].text.value;

            // Extract JSON from response (handles markdown code blocks)
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error("Agent response without JSON:", responseText);
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

            console.log(`✓ DocumentMap gerado pelo MapBuilder Agent`);
            return documentMap;

        } catch (error) {
            console.error("❌ Erro no MapBuilder Agent:", error.message);
            throw error; // Fail fast - critical component
        }
    }

    /**
     * Clean up: delete the assistant
     * Useful for testing or resetting
     */
    async cleanup() {
        if (!this.agentId) return;

        try {
            await this.client.beta.assistants.del(this.agentId);
            console.log(`✓ MapBuilder Agent deletado: ${this.agentId}`);
            this.agentId = null;
        } catch (error) {
            console.error("⚠️  Erro ao deletar MapBuilder Agent:", error.message);
        }
    }
}

# Evolução da Arquitetura - SuperTA

## Data: 31 de Janeiro de 2026

## Resumo das Mudanças

Transformação do MVP simples para arquitetura de **orquestração com dual-state** conforme especificado em [config/replit-future.md](config/replit-future.md).

---

## Mudanças Implementadas

### 1. ✅ Estrutura de Sessão Dual-State

**Antes:**
```javascript
{ systemPrompt, history: [], submissionPath, openaiFileId }
```

**Depois:**
```javascript
{
  systemPrompt,
  // Dual conversations
  conv_chat: [],        // Student-facing only
  conv_eval: [],        // Internal + evaluation signals
  history: [],          // Backward compatibility alias
  // Document understanding
  documentMap: null,    // Global document summary
  vectorStoreId: null,  // For RAG/file_search
  // State machine
  currentPhase: 'awaiting_upload|interviewing|finalizing',
  questionCount: 0,
  evaluationSignals: []
}
```

### 2. ✅ DocumentMap Generation

Geração automática após upload do arquivo com análise estruturada:
- Tese/objetivo principal
- Estrutura (seções)
- Metodologia
- Claims principais
- Pontos fracos

Arquivo: `generateDocumentMap()` em [server.js](server.js)

### 3. ✅ Vector Store Integration

Migração de Files API direta para **Vector Store com file_search**:
- Indexação automática do PDF
- Capacidade de RAG (retrieval-augmented generation)
- Verificação localizada de evidências

Arquivo: `createVectorStoreWithFile()` em [server.js](server.js)

### 4. ✅ Infraestrutura de Avaliadores

Dois avaliadores especializados implementados:

#### **ComprehensionEvaluator**
- Avalia se o aluno compreende o próprio trabalho
- Gera sinais estruturados (confidence, redFlags, suggestedFollowUp)
- Mapeia para critério C1 do rubric (40%)

#### **ClarificationEvaluator**
- Identifica aspectos não claros no documento/respostas
- Propõe perguntas específicas de clarificação
- Suporta o TA em fazer perguntas mais direcionadas

**Classe base:** `EvaluationSignal` para estruturar outputs

Arquivo: Seção "EVALUATORS INFRASTRUCTURE" em [server.js](server.js)

### 5. ✅ Turn Dynamics Protocol

Implementação do fluxo invariante:

```
1. Student responds
2. Store in conv_chat + conv_eval
3. Run evaluators (parallel)
4. Consolidate signals
5. Orchestrator decides next action
6. Generate TA response
```

**Princípio crítico:** Avaliação **só após input do estudante**, nunca após output do TA.

Arquivo: Endpoint `/chat` refatorado em [server.js](server.js)

### 6. ✅ Orquestração Inteligente

Função `orchestrateNextAction()` controla o fluxo:
- **Limite de perguntas:** MAX_QUESTIONS = 8
- **Threshold de follow-up:** 0.5
- **Decisões:**
  - `followup`: Usa pergunta sugerida por avaliador
  - `continue`: Gera nova pergunta via LLM
  - `finalize`: Sinaliza fim da entrevista

Arquivo: `orchestrateNextAction()` e `generateNextQuestion()` em [server.js](server.js)

### 7. ✅ Avaliação Final Baseada em Rubric

Substituição da heurística simples por **análise consolidada**:

**Antes:**
```javascript
interactions * 0.5 + clarity * 0.5 = score
```

**Depois:**
```javascript
C1 (Compreensão) * 0.4 + 
C2 (Metodologia) * 0.4 + 
C3 (Parâmetros) * 0.2 = score_total
```

- **C1:** Média dos sinais de comprehension
- **C2:** Avaliação LLM da correção metodológica
- **C3:** Avaliação LLM da adequação de parâmetros

Arquivo: Endpoint `/finalize` refatorado + funções auxiliares em [server.js](server.js)

---

## Compatibilidade

### ✅ Mantido
- Estrutura de rotas (`/session`, `/upload`, `/chat`, `/finalize`)
- Formato de requisições e respostas
- Frontend compatível (sem mudanças necessárias)
- Campo `history` como alias para `conv_chat`

### ⚠️ Mudanças Internas (não afetam frontend)
- Dual conversations adicionadas
- Avaliadores executam em background
- Orquestração controla fluxo de perguntas

---

## Arquivos Modificados

1. **[server.js](server.js)** - Refatoração completa com:
   - Estrutura de sessão expandida
   - Funções de DocumentMap
   - Vector Store integration
   - Infraestrutura de avaliadores
   - Turn Dynamics no `/chat`
   - Avaliação consolidada no `/finalize`

## Arquivos de Configuração (sem mudanças)

- [config/system_prompt.txt](config/system_prompt.txt) ✓
- [config/rubric.json](config/rubric.json) ✓
- [config/assignment.json](config/assignment.json) ✓
- [static/index.html](static/index.html) ✓

---

## Próximos Passos (Futuras Evoluções)

### Não implementado (mas planejado)

1. **Persistência de estado** em `data/state/`
   - Atualmente: Sessões em memória (volátil)
   - Futuro: Serializar sessões para disco

2. **Conversations API** da OpenAI
   - Atualmente: Usando Responses API
   - Futuro: Migrar para Conversations API para estado persistente

3. **Frontend aprimorado**
   - Indicadores de progresso da entrevista
   - Visualização de fase atual
   - Contador de perguntas restantes

4. **Mais avaliadores especializados**
   - Avaliador de originalidade
   - Avaliador de profundidade técnica
   - Avaliador de comunicação

5. **Auditoria e reporting**
   - Exportar `conv_eval` completo
   - Timeline de sinais de avaliação
   - Justificativas detalhadas por critério

---

## Como Executar

```bash
npm run dev
```

O servidor inicia em `http://localhost:5000` com a nova arquitetura totalmente funcional.

---

## Notas Técnicas

### Dependências OpenAI
- **SDK versão:** 4.56.0
- **APIs usadas:**
  - `openai.files.create()` - Upload de arquivos
  - `openai.beta.vectorStores.create()` - Vector Store para RAG
  - `openai.responses.create()` - Geração de respostas e avaliações

### Estrutura de Sinais
```javascript
{
  type: 'comprehension' | 'clarification',
  confidence: 0.0-1.0,
  data: {
    // Dados específicos do avaliador
  },
  timestamp: number
}
```

### Fases da Sessão
- `awaiting_upload`: Aguardando arquivo do estudante
- `interviewing`: Entrevista ativa
- `finalizing`: Pronto para gerar avaliação final

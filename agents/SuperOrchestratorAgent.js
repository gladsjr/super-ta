import log from "../lib/logger.js";
import { ACTION_SCHEMA_DESCRIPTION, validateAction } from "../lib/superOrchestrator/actionSchema.js";

/**
 * SuperOrchestratorAgent — FASE 1: stub.
 *
 * Substituirá triagem×3 + sufficiency + relevance + composição da próxima
 * pergunta numa única chamada de raciocínio por turno. Recebe contexto cheio
 * (system prompt + YAML do entrevistador + análise do trabalho + plano +
 * memory + histórico da conversa + última mensagem do aluno) e devolve a
 * próxima ação no schema definido em lib/superOrchestrator/actionSchema.js.
 *
 * Por enquanto: stub que devolve um ack constante. Não chama LLM. O wiring
 * real em /chat entra na fase 3; até lá nada do legado é afetado.
 *
 * Decisões importantes que entram no system prompt na fase 3 (ainda a fazer):
 *   - regras de transição entre kinds (quando ask vs follow_up vs finalize)
 *   - guardrails internos (não finalizar antes de N turnos, sem repetir
 *     pergunta já marcada como questions_covered)
 *   - como usar o bloco `memory` entre turnos
 *   - como espelhar interaction_style da agenda (mesma regra dos agentes legados)
 *   - modo áudio: evitar markdown
 *
 * Tools (fase 3): file_search sobre vector store com PDF do aluno + PDF do
 * enunciado. Hoje só o aluno é vetorizado; expandir para múltiplos docs vai
 * exigir mudança pequena em lib/sessionLifecycle.js#createVectorStoreWithFile.
 */
export class SuperOrchestratorAgent {
    static TYPE = "super_orchestrator";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for SuperOrchestratorAgent");
        this.client = openaiClient;
        this.model = model;
        // System prompt completo será escrito na fase 3. Por ora é placeholder
        // — o stub não envia nada para a LLM.
        this.systemPromptBody = `STUB DA FASE 1 — não enviado a modelo.\n\nSchema esperado da saída (em produção):\n${ACTION_SCHEMA_DESCRIPTION}`;
    }

    /**
     * evaluate({ ... contexto ... })
     *
     * Assinatura provisória — os parâmetros reais serão fechados na fase 3
     * (interviewerYamlText, workAnalysis, interviewPlan, memory, history,
     * studentMessage, vectorStoreId, studentName, meterCtx, interactionMode).
     *
     * Stub devolve um ask_repeat constante para que o despachante (quando
     * existir) tenha algo válido pra processar em testes manuais antes do
     * miolo entrar. validateAction é rodado pelo próprio stub para garantir
     * que o schema permanece honrado mesmo aqui.
     */
    async evaluate(_inputs = {}) {
        log.info("AGENT:SuperOrchestrator", "stub call — devolvendo ack constante (não chama LLM)");
        const stubResponse = {
            rationale: "Stub da fase 1 do experimento. Sem raciocínio real ainda — devolve ack constante para o despachante poder ser testado depois.",
            action: {
                kind: "ask_repeat",
                message: "[stub do super-orquestrador]",
            },
            memory: {
                questions_covered: [],
                questions_skipped: [],
                open_threads: [],
                free_notes: "stub",
            },
        };
        const v = validateAction(stubResponse);
        if (!v.valid) {
            throw new Error(`SuperOrchestratorAgent stub inválido pelo próprio schema (bug): ${v.errors.join("; ")}`);
        }
        return stubResponse;
    }
}

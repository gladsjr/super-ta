// Singletons dos 9 agentes. Cada agent é instanciado uma vez no boot com o
// modelo que ele consome (principal_reasoning_model ou fast_model).
// Quem precisa de um agente importa o singleton daqui.

import { MapBuilderAgent } from "../agents/MapBuilderAgent.js";
import { PlanBuilderAgent } from "../agents/PlanBuilderAgent.js";
import { ScopeClarificationAgent } from "../agents/ScopeClarificationAgent.js";
import { OffTopicRedirectAgent } from "../agents/OffTopicRedirectAgent.js";
import { MetaInterventionAgent } from "../agents/MetaInterventionAgent.js";
import { QuestionRelevanceAgent } from "../agents/QuestionRelevanceAgent.js";
import { AnswerSufficiencyAgent } from "../agents/AnswerSufficiencyAgent.js";
import { IntroductionAgent } from "../agents/IntroductionAgent.js";
import { AudioIntelligibilityAgent } from "../agents/AudioIntelligibilityAgent.js";
import { ConfigAssistantAgent } from "../agents/ConfigAssistantAgent.js";
import { EnunciadoCoherenceAgent } from "../agents/EnunciadoCoherenceAgent.js";
// --- Experimento super-orquestrador (branch experiment/super-orquestrador). ---
// Stubs por enquanto: instanciados mas não chamados por ninguém. Wiring em
// /upload (fase 2) e /chat (fase 3) virá em commits seguintes. Ver
// docs/super-orchestrator-plan.md.
import { SuperOrchestratorAgent } from "../agents/SuperOrchestratorAgent.js";
import { PrepBuilderAgent } from "../agents/PrepBuilderAgent.js";
import { openai } from "./openaiClient.js";
import { PRINCIPAL_REASONING_MODEL, FAST_MODEL } from "./config.js";

export const mapBuilderAgent = new MapBuilderAgent(openai, PRINCIPAL_REASONING_MODEL);
export const planBuilderAgent = new PlanBuilderAgent(openai, PRINCIPAL_REASONING_MODEL);
export const scopeClarificationAgent = new ScopeClarificationAgent(openai, FAST_MODEL);
export const offTopicRedirectAgent = new OffTopicRedirectAgent(openai, FAST_MODEL);
export const metaInterventionAgent = new MetaInterventionAgent(openai, FAST_MODEL);
export const questionRelevanceAgent = new QuestionRelevanceAgent(openai, FAST_MODEL);
export const answerSufficiencyAgent = new AnswerSufficiencyAgent(openai, PRINCIPAL_REASONING_MODEL);
export const introductionAgent = new IntroductionAgent(openai, FAST_MODEL);
export const audioIntelligibilityAgent = new AudioIntelligibilityAgent(openai, FAST_MODEL);
export const configAssistantAgent = new ConfigAssistantAgent(openai, FAST_MODEL);
export const enunciadoCoherenceAgent = new EnunciadoCoherenceAgent(openai, PRINCIPAL_REASONING_MODEL);

// --- Experimento (stubs por ora; ver agentes correspondentes). ---
export const superOrchestratorAgent = new SuperOrchestratorAgent(openai, PRINCIPAL_REASONING_MODEL);
export const prepBuilderAgent = new PrepBuilderAgent(openai, PRINCIPAL_REASONING_MODEL);

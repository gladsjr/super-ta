// Singletons dos agentes. Cada agent é instanciado uma vez no boot com o
// modelo que ele consome (principal_reasoning_model ou fast_model). Quem
// precisa de um agente importa o singleton daqui.
//
// Conjunto após a reforma do super-orquestrador (merge dae5780):
//   /upload          → PrepBuilderAgent (analyzeWork + buildPlan).
//   /chat intro      → IntroductionAgent (roteiro de 3 beats).
//   /chat áudio gate → AudioIntelligibilityAgent (só fraseia; algoritmo decide).
//   /chat interview  → SuperOrchestratorAgent (1 reasoning call por turno).
//   /config-chat     → ConfigAssistantAgent (assistente do professor).
//   /coherence       → EnunciadoCoherenceAgent (avaliação do enunciado).
//   /evaluation      → InterviewEvaluatorAgent (avaliação da entrevista).
//   /publish         → StudentFeedbackAgent (devolutiva formativa ao aluno).
//   /grades          → GradingAgent (nota de cada critério da rubrica).
//
// Não há mais triagem×3 nem sufficiency/relevance/MapBuilder/PlanBuilder
// separados — tudo absorvido pelo super-orquestrador e pelo PrepBuilder.

import { IntroductionAgent } from "../agents/IntroductionAgent.js";
import { AudioIntelligibilityAgent } from "../agents/AudioIntelligibilityAgent.js";
import { ConfigAssistantAgent } from "../agents/ConfigAssistantAgent.js";
import { EnunciadoCoherenceAgent } from "../agents/EnunciadoCoherenceAgent.js";
import { SuperOrchestratorAgent } from "../agents/SuperOrchestratorAgent.js";
import { ScenarioOrchestratorAgent } from "../agents/ScenarioOrchestratorAgent.js";
import { ScenarioPrepAgent } from "../agents/ScenarioPrepAgent.js";
import { ScenarioAssistantAgent } from "../agents/ScenarioAssistantAgent.js";
import { ScenarioEvaluatorAgent } from "../agents/ScenarioEvaluatorAgent.js";
import { PrepBuilderAgent } from "../agents/PrepBuilderAgent.js";
import { InterviewEvaluatorAgent } from "../agents/InterviewEvaluatorAgent.js";
import { StudentFeedbackAgent } from "../agents/StudentFeedbackAgent.js";
import { GradingAgent } from "../agents/GradingAgent.js";

import { openai } from "./openaiClient.js";
import { PRINCIPAL_REASONING_MODEL, FAST_MODEL } from "./config.js";

export const introductionAgent = new IntroductionAgent(openai, FAST_MODEL);
export const audioIntelligibilityAgent = new AudioIntelligibilityAgent(openai, FAST_MODEL);
export const configAssistantAgent = new ConfigAssistantAgent(openai, FAST_MODEL);
export const enunciadoCoherenceAgent = new EnunciadoCoherenceAgent(openai, PRINCIPAL_REASONING_MODEL);
export const interviewEvaluatorAgent = new InterviewEvaluatorAgent(openai, PRINCIPAL_REASONING_MODEL);
export const studentFeedbackAgent = new StudentFeedbackAgent(openai, PRINCIPAL_REASONING_MODEL);
export const gradingAgent = new GradingAgent(openai, PRINCIPAL_REASONING_MODEL);
export const superOrchestratorAgent = new SuperOrchestratorAgent(openai, PRINCIPAL_REASONING_MODEL);
export const prepBuilderAgent = new PrepBuilderAgent(openai, PRINCIPAL_REASONING_MODEL);
// Sistema multiagente (cenários). Mesmo modelo de raciocínio do super-orquestrador.
export const scenarioOrchestratorAgent = new ScenarioOrchestratorAgent(openai, PRINCIPAL_REASONING_MODEL);
// Prep por interação: lê o contexto inteiro (PDFs) e planeja a etapa, semeando a memory.
export const scenarioPrepAgent = new ScenarioPrepAgent(openai, PRINCIPAL_REASONING_MODEL);
// Assistente do professor no estúdio de cenários (fast_model, JSON de propostas).
export const scenarioAssistantAgent = new ScenarioAssistantAgent(openai, FAST_MODEL);
// Avaliação interna de um run multi-interação (professor-only).
export const scenarioEvaluatorAgent = new ScenarioEvaluatorAgent(openai, PRINCIPAL_REASONING_MODEL);

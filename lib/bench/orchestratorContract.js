import {
    ACTION_KINDS,
    FINALIZE_REASONS,
    FOLLOW_UP_REASONS,
    validateAction,
} from "../superOrchestrator/actionSchema.js";

const nullableString = { type: ["string", "null"] };
const stringArray = { type: "array", items: { type: "string" } };

export const orchestratorOutputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["action", "rationale", "memory"],
    properties: {
        action: {
            type: "object",
            additionalProperties: false,
            required: [
                "kind", "message", "plan_question_id", "revisit_topic", "objectives",
                "concerns", "decision_criteria", "information_needs", "evaluation_mode",
                "about_turn_index", "follow_up_reason", "hint", "finalize_reason",
            ],
            properties: {
                kind: { type: "string", enum: ACTION_KINDS },
                message: { type: "string", minLength: 1 },
                plan_question_id: nullableString,
                revisit_topic: nullableString,
                objectives: stringArray,
                concerns: stringArray,
                decision_criteria: stringArray,
                information_needs: stringArray,
                evaluation_mode: stringArray,
                about_turn_index: { type: ["integer", "null"] },
                follow_up_reason: { type: ["string", "null"], enum: [...FOLLOW_UP_REASONS, null] },
                hint: {
                    anyOf: [
                        { type: "null" },
                        {
                            type: "object",
                            additionalProperties: false,
                            required: ["title", "body"],
                            properties: { title: { type: "string" }, body: { type: "string" } },
                        },
                    ],
                },
                finalize_reason: { type: ["string", "null"], enum: [...FINALIZE_REASONS, null] },
            },
        },
        rationale: { type: "string", minLength: 1 },
        memory: {
            type: "object",
            additionalProperties: false,
            required: ["questions_covered", "questions_skipped", "open_threads", "free_notes"],
            properties: {
                questions_covered: stringArray,
                questions_skipped: stringArray,
                open_threads: stringArray,
                free_notes: { type: "string" },
            },
        },
    },
};

export const judgmentDimensions = [
    "decision_quality",
    "message_quality",
    "action_message_coherence",
    "state_update_quality",
    "context_use",
    "persona_fidelity",
    "oral_answerability",
];

export const orchestratorJudgmentSchema = {
    type: "object",
    additionalProperties: false,
    required: ["winner", "score", "dimensions", "confidence", "critical_failure", "rationale"],
    properties: {
        winner: { type: "string", enum: ["A", "B", "tie"] },
        score: { type: "number", minimum: -1, maximum: 1 },
        dimensions: {
            type: "object",
            additionalProperties: false,
            required: judgmentDimensions,
            properties: Object.fromEntries(judgmentDimensions.map((name) => [name, { type: "number", minimum: -1, maximum: 1 }])),
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        critical_failure: { type: "boolean" },
        rationale: { type: "string", minLength: 1 },
    },
};

export const setupVoteSchema = {
    type: "object",
    additionalProperties: false,
    required: ["selected_proposal_id", "acceptable_proposal_ids", "acceptable_kinds", "forbidden_kinds", "confidence", "rationale"],
    properties: {
        selected_proposal_id: { type: "string", minLength: 1 },
        acceptable_proposal_ids: stringArray,
        acceptable_kinds: { type: "array", items: { type: "string", enum: ACTION_KINDS } },
        forbidden_kinds: { type: "array", items: { type: "string", enum: ACTION_KINDS } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string", minLength: 1 },
    },
};

export const studentReplySchema = {
    type: "object",
    additionalProperties: false,
    required: ["message", "behavior_observed"],
    properties: {
        message: { type: "string", minLength: 1 },
        behavior_observed: { type: "string" },
    },
};

export function normalizeOrchestratorOutput(value) {
    const action = value?.action || {};
    return {
        action: {
            kind: action.kind ?? "ask_repeat",
            message: String(action.message || "Pode repetir sua ultima resposta, por favor?"),
            plan_question_id: action.plan_question_id == null ? null : String(action.plan_question_id),
            revisit_topic: action.revisit_topic == null ? null : String(action.revisit_topic),
            objectives: Array.isArray(action.objectives) ? action.objectives.map(String) : [],
            concerns: Array.isArray(action.concerns) ? action.concerns.map(String) : [],
            decision_criteria: Array.isArray(action.decision_criteria) ? action.decision_criteria.map(String) : [],
            information_needs: Array.isArray(action.information_needs) ? action.information_needs.map(String) : [],
            evaluation_mode: Array.isArray(action.evaluation_mode) ? action.evaluation_mode.map(String) : [],
            about_turn_index: Number.isInteger(action.about_turn_index) ? action.about_turn_index : null,
            follow_up_reason: action.follow_up_reason ?? null,
            hint: action.hint && typeof action.hint === "object"
                ? { title: String(action.hint.title || ""), body: String(action.hint.body || "") }
                : null,
            finalize_reason: action.finalize_reason ?? null,
        },
        rationale: String(value?.rationale || ""),
        memory: {
            questions_covered: Array.isArray(value?.memory?.questions_covered) ? value.memory.questions_covered.map(String) : [],
            questions_skipped: Array.isArray(value?.memory?.questions_skipped) ? value.memory.questions_skipped.map(String) : [],
            open_threads: Array.isArray(value?.memory?.open_threads) ? value.memory.open_threads.map(String) : [],
            free_notes: String(value?.memory?.free_notes || ""),
        },
    };
}

// Duas camadas de validade, separadas de propósito:
// - `executable` = validateAction de PRODUÇÃO: inválido ali significa que o
//   despachante real cairia no fallback ask_repeat (falha dura).
// - `conditional_errors` = regras condicionais EXTRAS do benchmark (metadados
//   desejáveis: índice do follow_up, razões, revisit_topic). Produção tolera a
//   omissão; aqui vira não-conformidade, não falha crítica.
export function validateOrchestratorOutput(value) {
    const normalized = normalizeOrchestratorOutput(value);
    const production = validateAction(normalized);
    const conditionalErrors = [];
    const action = normalized.action;
    if (action.kind === "follow_up" && !Number.isInteger(action.about_turn_index)) conditionalErrors.push("follow_up exige about_turn_index");
    if (action.kind === "follow_up" && !FOLLOW_UP_REASONS.includes(action.follow_up_reason)) conditionalErrors.push("follow_up exige follow_up_reason");
    if (action.kind === "finalize" && !FINALIZE_REASONS.includes(action.finalize_reason)) conditionalErrors.push("finalize exige finalize_reason");
    if (action.kind === "ask" && action.plan_question_id == null && !action.revisit_topic) conditionalErrors.push("ask espontanea exige revisit_topic");
    const errors = [...production.errors, ...conditionalErrors];
    return { valid: errors.length === 0, errors, normalized, executable: production.valid, conditional_errors: conditionalErrors };
}

// Avaliação DECOMPOSTA em três eixos independentes (antes tudo era uma métrica
// só, "acceptable", que misturava executabilidade, conformidade de metadados e
// adequação à política — e o percentual baixo não dizia POR QUE):
// - executable: passaria no validador/despachante reais (sem fallback).
// - compliant:  metadados condicionais completos + campos exigidos do cenário.
// - adequate:   o TIPO de ação está na política do conselho (e não é proibido).
// `acceptable` continua sendo a composição das três (compatível com o valor
// histórico); `critical_failure` agora é só falha DURA (inexecutável/proibida)
// — omissão de metadado é degradação, não catástrofe, espelhando produção.
export function assessAction(output, policy = {}) {
    const validation = validateOrchestratorOutput(output);
    const kind = validation.normalized.action.kind;
    const preferredKind = policy.preferred_kind || null;
    const acceptableKinds = new Set(policy.acceptable_kinds || (preferredKind ? [preferredKind] : ACTION_KINDS));
    const forbiddenKinds = new Set(policy.forbidden_kinds || []);
    const fieldMatches = {};
    for (const [field, expected] of Object.entries(policy.required_action_fields || {})) {
        const actual = validation.normalized.action[field];
        fieldMatches[field] = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
    }
    const requiredFieldsMatch = Object.values(fieldMatches).every(Boolean);
    const forbidden = forbiddenKinds.has(kind);
    const executable = validation.executable;
    const compliant = validation.conditional_errors.length === 0 && requiredFieldsMatch;
    const adequate = acceptableKinds.has(kind) && !forbidden;
    return {
        schema_valid: validation.valid,
        validation_errors: validation.errors,
        action_kind: kind,
        expected_preferred_kind: preferredKind,
        executable,
        compliant,
        adequate,
        preferred: validation.valid && kind === preferredKind && requiredFieldsMatch,
        acceptable: executable && compliant && adequate,
        forbidden,
        required_fields_match: requiredFieldsMatch,
        field_matches: fieldMatches,
        critical_failure: !executable || forbidden,
    };
}

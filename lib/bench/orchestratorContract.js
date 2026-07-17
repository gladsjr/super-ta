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

export function validateOrchestratorOutput(value) {
    const normalized = normalizeOrchestratorOutput(value);
    const result = validateAction(normalized);
    const errors = [...result.errors];
    const action = normalized.action;
    if (action.kind === "follow_up" && !Number.isInteger(action.about_turn_index)) errors.push("follow_up exige about_turn_index");
    if (action.kind === "follow_up" && !FOLLOW_UP_REASONS.includes(action.follow_up_reason)) errors.push("follow_up exige follow_up_reason");
    if (action.kind === "finalize" && !FINALIZE_REASONS.includes(action.finalize_reason)) errors.push("finalize exige finalize_reason");
    if (action.kind === "ask" && action.plan_question_id == null && !action.revisit_topic) errors.push("ask espontanea exige revisit_topic");
    return { valid: errors.length === 0, errors, normalized };
}

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
    return {
        schema_valid: validation.valid,
        validation_errors: validation.errors,
        action_kind: kind,
        expected_preferred_kind: preferredKind,
        preferred: validation.valid && kind === preferredKind && requiredFieldsMatch,
        acceptable: validation.valid && acceptableKinds.has(kind) && !forbidden && requiredFieldsMatch,
        forbidden,
        required_fields_match: requiredFieldsMatch,
        field_matches: fieldMatches,
        critical_failure: !validation.valid || forbidden,
    };
}

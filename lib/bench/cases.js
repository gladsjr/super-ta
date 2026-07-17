import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./util.js";
import { ACTION_KINDS } from "../superOrchestrator/actionSchema.js";
import { validateOrchestratorOutput } from "./orchestratorContract.js";

function requiredString(value, field, file) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: campo obrigatorio ${field}`);
}

export function validateCaseSeed(item, file = "caso") {
    if (item?.schema_version !== 3) throw new Error(`${file}: schema_version deve ser 3`);
    requiredString(item?.id, "id", file);
    requiredString(item?.area, "area", file);
    requiredString(item?.large_area, "large_area", file);
    requiredString(item?.interviewer_persona?.key, "interviewer_persona.key", file);
    requiredString(item?.interviewer_persona?.description, "interviewer_persona.description", file);
    requiredString(item?.student_persona?.key, "student_persona.key", file);
    requiredString(item?.student_persona?.description, "student_persona.description", file);
    requiredString(item?.assignment, "assignment", file);
    requiredString(item?.student_work, "student_work", file);
    requiredString(item?.investigation_points, "investigation_points", file);
    requiredString(item?.interview_plan?.opening_question, "interview_plan.opening_question", file);
    if (!Array.isArray(item?.interview_plan?.objectives) || item.interview_plan.objectives.length < 2) throw new Error(`${file}: interview_plan.objectives deve ter ao menos dois objetivos`);
    const objectiveIds = new Set();
    for (const objective of item.interview_plan.objectives) {
        requiredString(objective?.id, "interview_plan.objectives[].id", file);
        requiredString(objective?.description, "interview_plan.objectives[].description", file);
        if (objectiveIds.has(objective.id)) throw new Error(`${file}: objetivo duplicado ${objective.id}`);
        objectiveIds.add(objective.id);
    }
    if (!Array.isArray(item?.student_states) || item.student_states.length < 2) throw new Error(`${file}: student_states deve ter ao menos dois estados`);
    const stateIds = new Set();
    for (const [index, state] of item.student_states.entries()) {
        requiredString(state?.id, "student_states[].id", file);
        requiredString(state?.objective_id, "student_states[].objective_id", file);
        requiredString(state?.behavior, "student_states[].behavior", file);
        requiredString(state?.response_guidance, "student_states[].response_guidance", file);
        if (!objectiveIds.has(state.objective_id)) throw new Error(`${file}: objetivo inexistente em ${state.id}: ${state.objective_id}`);
        if (stateIds.has(state.id)) throw new Error(`${file}: estado duplicado ${state.id}`);
        const source = state?.responds_to?.source;
        if (index === 0 && source !== "opening_question") throw new Error(`${file}: primeiro estado deve responder a opening_question`);
        if (index > 0) {
            if (source !== "previous_canonical_action") throw new Error(`${file}: ${state.id} deve responder a previous_canonical_action`);
            if (state.responds_to.state_id !== item.student_states[index - 1].id) throw new Error(`${file}: ${state.id} deve apontar para o estado anterior`);
        }
        if (!Array.isArray(state.expected_action_kinds) || !state.expected_action_kinds.length) throw new Error(`${file}: ${state.id}.expected_action_kinds vazio`);
        if (state.expected_action_kinds.some((kind) => !ACTION_KINDS.includes(kind))) throw new Error(`${file}: expected_action_kinds invalido`);
        stateIds.add(state.id);
    }
    return item;
}

export function validateFrozenCase(item, file = "caso congelado") {
    validateCaseSeed(item, file);
    if (!Array.isArray(item.turns) || !item.turns.length) throw new Error(`${file}: turns deve ser lista nao vazia`);
    const ids = new Set();
    for (const turn of item.turns) {
        requiredString(turn?.id, "turns[].id", file);
        if (ids.has(turn.id)) throw new Error(`${file}: turno duplicado ${turn.id}`);
        ids.add(turn.id);
        if (!Array.isArray(turn.history)) throw new Error(`${file}: ${turn.id}.history deve ser lista`);
        requiredString(turn.student_message, `${turn.id}.student_message`, file);
        if (!turn.canonical?.output || !turn.canonical?.policy) throw new Error(`${file}: ${turn.id}.canonical incompleto`);
        const validation = validateOrchestratorOutput(turn.canonical.output);
        if (!validation.valid) throw new Error(`${file}: ${turn.id}.canonical.output invalido: ${validation.errors.join("; ")}`);
        requiredString(turn.canonical.policy.preferred_kind, `${turn.id}.canonical.policy.preferred_kind`, file);
        if (!Array.isArray(turn.canonical.policy.acceptable_kinds) || !turn.canonical.policy.acceptable_kinds.length) throw new Error(`${file}: ${turn.id}.canonical.policy.acceptable_kinds vazio`);
    }
    return item;
}

function loadFromDirectory(casesDir, selectedIds) {
    const files = fs.readdirSync(casesDir).filter((name) => name.endsWith(".json")).sort();
    const wanted = new Set(selectedIds);
    const cases = files.map((name) => {
        const file = path.join(casesDir, name);
        const item = validateCaseSeed(JSON.parse(fs.readFileSync(file, "utf8")), file);
        return {
            ...item,
            source_file: name,
            source_hash: sha256({ assignment: item.assignment, student_work: item.student_work }),
        };
    }).filter((item) => !wanted.size || wanted.has(item.id));
    if (!cases.length) throw new Error("nenhum caso selecionado");
    if (wanted.size) {
        const found = new Set(cases.map((item) => item.id));
        const missing = [...wanted].filter((id) => !found.has(id));
        if (missing.length) throw new Error(`casos nao encontrados: ${missing.join(", ")}`);
    }
    return cases;
}

export function loadCaseSeeds(casesDir, selectedIds = []) {
    return loadFromDirectory(casesDir, selectedIds);
}

// Mantido como nome publico para as rotas; agora carrega casos-fonte, nao entrevistas.
export const loadCases = loadCaseSeeds;

export function validateFrozenCases(cases) {
    if (!Array.isArray(cases) || !cases.length) throw new Error("setup sem casos congelados");
    return cases.map((item, index) => validateFrozenCase(item, `caso congelado ${index + 1}`));
}

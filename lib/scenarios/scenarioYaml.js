// Import/export de CENÁRIO em YAML — formato humano que o professor pode
// editar/versionar/compartilhar. NÃO é o formato canônico (o estúdio segue com
// formulário + objeto em JSONB): é só uma ponte de serialização.
//
// O YAML pode ser de granularidade dupla:
//   - CENÁRIO inteiro: { name, description, personas:[...], interactions:[...] }
//     (participantes referenciam personas por NOME — mais legível que id).
//   - PERSONA isolada: os campos do perfil (sem id).
// `parseYaml` detecta qual recebeu. Ids (cp_*) ficam FORA do YAML — são
// internos; o save normal (cleanScenario/validateScenario em routes/scenarios.js)
// faz a validação dura quando o professor clica Salvar.

import { randomUUID } from "crypto";
import yaml from "js-yaml";
import { normalizeForm, formKind, FORM_DEFAULT_WORK } from "./interactionForms.js";

const str = (v) => (v == null ? "" : String(v));
const list = (v) =>
    Array.isArray(v) ? v.filter((x) => x != null && String(x).trim() !== "").map((x) => String(x).trim())
    : (v != null && String(v).trim() !== "" ? [String(v).trim()] : []);
const cpId = () => `cp_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const DUMP = { indent: 2, lineWidth: -1, noRefs: true };

// ---- objeto-persona → objeto YAML (sem id/template_id; só o que é humano) ----
function personaToObj(p) {
    const k = p.knowledge || {};
    const o = { name: str(p.name), icon: str(p.icon) || "🧑", role: str(p.role) };
    if (str(p.gender)) o.gender = str(p.gender);
    if (str(p.voice)) o.voice = str(p.voice);
    if (str(p.tone)) o.tone = str(p.tone);
    if (str(p.description)) o.description = str(p.description);
    if (str(p.authority)) o.authority = str(p.authority);
    for (const f of ["objectives", "concerns", "decision_criteria", "constraints", "information_needs", "evaluation_mode"]) {
        const v = list(p[f]);
        if (v.length) o[f] = v;
    }
    const scope = list(k.scope);
    const assets = (Array.isArray(k.assets) ? k.assets : []).filter((a) => a && a.label);
    const level = str(k.level);
    if (scope.length || assets.length || level) {
        o.knowledge = {};
        if (scope.length) o.knowledge.scope = scope;
        if (level) o.knowledge.level = level;
        if (assets.length) o.knowledge.assets = assets.map((a) => ({ type: str(a.type), label: str(a.label) }));
    }
    const eq = list(p.example_questions);
    if (eq.length) o.example_questions = eq;
    return o;
}

// ---- objeto YAML → objeto-persona (forma do formulário; gera cp_*) ----
function personaFromObj(o) {
    const k = o.knowledge || {};
    return {
        id: cpId(),
        name: str(o.name),
        icon: str(o.icon) || "🧑",
        role: str(o.role),
        gender: str(o.gender),
        voice: str(o.voice),
        tone: str(o.tone),
        description: str(o.description),
        authority: str(o.authority),
        objectives: list(o.objectives),
        concerns: list(o.concerns),
        decision_criteria: list(o.decision_criteria),
        constraints: list(o.constraints),
        information_needs: list(o.information_needs),
        evaluation_mode: list(o.evaluation_mode),
        knowledge: {
            scope: list(k.scope),
            assets: Array.isArray(k.assets) ? k.assets.map((a) => ({ type: str(a?.type), label: str(a?.label) })).filter((a) => a.label) : [],
            level: str(k.level),
        },
        example_questions: list(o.example_questions),
    };
}

export function personaToYaml(persona) {
    return yaml.dump(personaToObj(persona || {}), DUMP);
}

export function scenarioToYaml(scenario) {
    const s = scenario || {};
    const byId = {};
    for (const p of s.personas || []) byId[p.id] = p;
    const doc = {
        name: str(s.name),
        description: str(s.description),
    };
    if (str(s.out_of_scope)) doc.out_of_scope = str(s.out_of_scope);
    if (str(s.premissas)) doc.premissas = str(s.premissas);
    doc.personas = (s.personas || []).map(personaToObj);
    doc.interactions = (s.interactions || []).map((it) => {
            const form = normalizeForm(it);
            const isEx = formKind(form) === "persona_exchange";
            const o = { title: str(it.title), form };
            if (str(it.form_prompt)) o.form_prompt = str(it.form_prompt);
            o.includes_student_work = !!it.includes_student_work;
            if (typeof it.time_limit_min === "number" && it.time_limit_min > 0) o.time_limit_min = it.time_limit_min;
            o.participants = (it.participants || []).map((part) => {
                const name = str(byId[part.persona_id]?.name || part.persona_id);
                return isEx ? { persona: name } : { persona: name, role: str(part.role) };
            });
            if (isEx) { if (str(it.focus)) o.focus = str(it.focus); }
            else if (str(it.instruction)) o.instruction = str(it.instruction);
            const eq = list(it.example_questions);
            if (eq.length) o.example_questions = eq;
            const pi = (Array.isArray(it.private_info) ? it.private_info : [])
                .map((x) => ({ info: str(x.text), personas: (x.persona_ids || []).map((id) => str(byId[id]?.name || id)) }))
                .filter((x) => x.info);
            if (pi.length) o.private_info = pi;
            return o;
    });
    return yaml.dump(doc, DUMP);
}

function scenarioFromObj(data) {
    if (!str(data.name)) throw new Error("cenário precisa de um 'name'");
    const personas = (Array.isArray(data.personas) ? data.personas : []).map(personaFromObj);
    const byName = {};
    for (const p of personas) if (p.name) byName[p.name.toLowerCase()] = p.id;
    const interactions = (Array.isArray(data.interactions) ? data.interactions : []).map((it, i) => {
        const form = normalizeForm({ form: it.form, objective_type: it.objective ?? it.objective_type, kind: it.kind });
        const kind = formKind(form);
        const participants = (Array.isArray(it.participants) ? it.participants : []).map((part) => {
            const ref = str(part.persona ?? part.persona_id ?? part.name).toLowerCase();
            const pid = byName[ref];
            if (!pid) throw new Error(`interação "${str(it.title) || i + 1}": persona "${str(part.persona ?? part.persona_id)}" não está nas personas do cenário`);
            return { persona_id: pid, role: str(part.role) || "questionamento" };
        });
        return {
            title: str(it.title),
            form,
            form_prompt: str(it.form_prompt),
            includes_student_work: typeof it.includes_student_work === "boolean" ? it.includes_student_work : !!FORM_DEFAULT_WORK[form],
            kind,
            participants,
            opener_persona_id: participants[0]?.persona_id || null,
            focus: kind === "persona_exchange" ? str(it.focus) : "",
            instruction: kind === "persona_exchange" ? "" : str(it.instruction),
            example_questions: list(it.example_questions),
            time_limit_min: (typeof it.time_limit_min === "number" && it.time_limit_min > 0) ? Math.round(it.time_limit_min) : null,
            private_info: (Array.isArray(it.private_info) ? it.private_info : [])
                .map((x) => ({ text: str(x.info ?? x.text), persona_ids: (Array.isArray(x.personas) ? x.personas : []).map((n) => byName[str(n).toLowerCase()]).filter(Boolean) }))
                .filter((x) => x.text),
        };
    });
    return { name: str(data.name), description: str(data.description), out_of_scope: str(data.out_of_scope), premissas: str(data.premissas), personas, interactions };
}

// Detecta a granularidade do YAML colado e devolve o objeto na forma do
// formulário. Lança Error com mensagem amigável em parse/estrutura inválida.
export function parseYaml(text) {
    let data;
    try {
        data = yaml.load(text);
    } catch (e) {
        throw new Error(`YAML inválido: ${e.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("YAML vazio ou em formato inesperado");
    if (Array.isArray(data.interactions) || Array.isArray(data.personas)) {
        return { kind: "scenario", scenario: scenarioFromObj(data) };
    }
    if (str(data.role) || Array.isArray(data.objectives) || str(data.name)) {
        const persona = personaFromObj(data);
        if (!persona.name || !persona.role) throw new Error("persona precisa de 'name' e 'role'");
        return { kind: "persona", persona };
    }
    throw new Error("não reconheci o YAML como cenário (com 'interactions'/'personas') nem como persona (com 'role')");
}

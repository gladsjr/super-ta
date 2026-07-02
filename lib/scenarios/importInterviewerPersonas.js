// Converte os entrevistadores (config/interviewers/*.yaml) em PERSONAS-TEMPLATE
// do estúdio de cenários, para que as personas que o professor já usava na
// entrevista fiquem disponíveis na biblioteca do estúdio ("+ Usar no cenário").
//
// O YAML do entrevistador tem um bloco agent.* (role, objetivos, preocupações,
// critérios, etc.) que mapeia quase 1:1 para a persona do cenário. Campos sem
// equivalente — gênero, voz, perguntas-exemplo — ficam vazios para o professor
// preencher (a entrevista sorteia nome/voz em runtime; a persona de cenário não).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERVIEWERS_DIR = path.join(LIB_DIR, "..", "..", "config", "interviewers");

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()) : v ? [v] : []);

function personaFromInterviewer(filename, yamlText) {
    const data = yaml.load(yamlText) || {};
    const a = data.agent || {};
    const kp = a.knowledge_profile || {};
    const name = filename.replace(/\.ya?ml$/i, "");
    return {
        id: `t_iv_${slug(name)}`,
        name,
        icon: "🧑",
        role: String(a.role || ""),
        gender: "",
        voice: "",
        description: String(a.description || ""),
        authority: String(a.authority || ""),
        tone: list(a.interaction_style).join(", "),
        objectives: list(a.objectives),
        concerns: list(a.concerns),
        decision_criteria: list(a.decision_criteria),
        constraints: list(a.constraints),
        information_needs: list(a.information_needs),
        evaluation_mode: list(a.evaluation_mode),
        knowledge: {
            scope: list(kp.knowledge_scope),
            assets: Array.isArray(kp.knowledge_assets)
                ? kp.knowledge_assets.map((x) => ({ type: String(x?.type || ""), label: String(x?.label || "") })).filter((x) => x.label)
                : [],
            level: String(kp.knowledge_level || ""),
        },
        example_questions: [],
        source: "interviewer",
    };
}

let _cache = null;
export function interviewerPersonaTemplates() {
    if (_cache) return _cache;
    let files = [];
    try {
        files = fs.readdirSync(INTERVIEWERS_DIR).filter((f) => /\.ya?ml$/i.test(f));
    } catch {
        return (_cache = []);
    }
    _cache = files
        .map((f) => {
            try {
                return personaFromInterviewer(f, fs.readFileSync(path.join(INTERVIEWERS_DIR, f), "utf8"));
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    return _cache;
}

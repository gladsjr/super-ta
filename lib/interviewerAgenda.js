import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(LIB_DIR, "..", "config", "interviewer_agenda_template.txt");

let _templateCache = null;
function loadTemplate() {
    if (_templateCache == null) {
        _templateCache = fs.readFileSync(TEMPLATE_PATH, "utf8");
    }
    return _templateCache;
}

function str(v) {
    return v == null ? "" : String(v);
}

function yamlBlock(value, indent = 4) {
    const pad = " ".repeat(indent);
    if (value == null) return `${pad}[]`;
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) return `${pad}[]`;
    const dumped = yaml.dump(list, { indent: 2, lineWidth: -1 }).trimEnd();
    return dumped.split("\n").map(l => pad + l).join("\n");
}

// Build the substitution map used by both the interview-plan template and the
// standalone agenda template. Callers may extend this with their own keys.
export function buildInterviewerSubs(interviewerYamlText) {
    const data = yaml.load(interviewerYamlText) || {};
    const agent = data.agent || {};
    const kp = agent.knowledge_profile || {};
    const scenario = data.scenario || {};
    const ctx = scenario.case_context || {};
    const conversation = data.conversation || {};
    return {
        role: str(agent.role),
        authority: str(agent.authority),
        relationship_to_student: str(agent.relationship_to_student),
        objectives_yaml_block: yamlBlock(agent.objectives),
        concerns_yaml_block: yamlBlock(agent.concerns),
        decision_criteria_yaml_block: yamlBlock(agent.decision_criteria),
        constraints_yaml_block: yamlBlock(agent.constraints),
        interaction_style_yaml_block: yamlBlock(agent.interaction_style),
        information_needs_yaml_block: yamlBlock(agent.information_needs),
        evaluation_mode_yaml_block: yamlBlock(agent.evaluation_mode),
        knowledge_scope_yaml_block: yamlBlock(kp.knowledge_scope),
        knowledge_assets_yaml_block: yamlBlock(kp.knowledge_assets),
        knowledge_level: str(kp.knowledge_level),
        scenario_type: str(scenario.scenario_type),
        origin_of_demand: str(scenario.origin_of_demand),
        organizational_setting: str(scenario.organizational_setting),
        case_summary: str(ctx.summary),
        case_stage: str(ctx.stage),
        case_urgency: str(ctx.urgency),
        stakes_yaml_block: yamlBlock(ctx.stakes),
        contextual_agenda_yaml_block: yamlBlock(conversation.contextual_agenda),
    };
}

export function applySubs(template, subs) {
    return template.replace(/\{\{(\w+)\}\}/g, (m, key) =>
        Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : m
    );
}

// Renders the standalone agenda block with explanatory prose, ready to be
// injected as context for any agent that needs to know the interviewer persona.
export function renderInterviewerAgenda(interviewerYamlText) {
    const subs = buildInterviewerSubs(interviewerYamlText);
    return applySubs(loadTemplate(), subs);
}

// Esqueleto canônico (chaves + hierarquia + significado) da agenda do
// entrevistador. É um CONTRATO DE ESTRUTURA — não uma config crua — usado por
// agentes que precisam EMITIR/EDITAR o YAML (ex.: ConfigAssistantAgent) para
// que produzam chaves válidas sem inventar nem omitir. Fonte única da forma do
// YAML; se a estrutura mudar, muda aqui. (Honra o CLAUDE.md: nenhuma config
// real vai ao LLM; só o esqueleto explicado + a agenda renderizada.)
export const INTERVIEWER_YAML_SKELETON = `agent:
  role: "..."                    # quem é o entrevistador (papel/função no caso)
  description: "..."             # uma frase descrevendo o personagem
  authority: "..."               # poder efetivo: decidir, aprovar, vetar, recomendar, cobrar, esclarecer...
  relationship_to_student: "..." # relação com o aluno: cliente, avaliador acadêmico, chefe, fonte...
  objectives:                    # o que ele busca alcançar/confirmar na entrevista (lista)
    - "..."
  concerns:                      # o que costuma preocupá-lo e disparar perguntas (lista)
    - "..."
  decision_criteria:             # por quais critérios julga as respostas (lista)
    - "..."
  constraints:                   # (opcional) limites do mundo real que ele considera (tempo, alçada, escopo)
    - "..."
  interaction_style:             # traços de como conduz: direto, cético, didático, investigativo... (lista)
    - "..."
  information_needs:             # (opcional) que informações precisa obter (lista)
    - "..."
  evaluation_mode:               # (opcional) como testa/pressiona: pede exemplos, tensiona premissas... (lista)
    - "..."
  knowledge_profile:             # (opcional) o que o entrevistador domina
    knowledge_scope:
      - "..."
    knowledge_assets:
      - "..."
    knowledge_level: "..."
scenario:
  scenario_type: "..."           # tipo de situação: arguição acadêmica, avaliação de proposta, pitch...
  origin_of_demand: "..."        # de onde surgiu a demanda/motivo da interação
  organizational_setting: "..."  # enquadramento: serviço interno, fornecedor-cliente, educacional...
  case_context:
    summary: "..."               # resumo do caso concreto entregue pelo aluno
    stage: "..."                 # momento do caso em que a interação acontece
    urgency: "..."               # grau de urgência
    stakes:                      # o que está em jogo (riscos, impactos, interesses) (lista)
      - "..."
conversation:
  contextual_agenda:             # tópicos/focos mais ativos nesta entrevista específica (lista)
    - "..."`;


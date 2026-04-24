import yaml from "js-yaml";

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

export function renderInterviewPrompt(template, interviewerYamlText, questionCount) {
    const data = yaml.load(interviewerYamlText) || {};
    const agent = data.agent || {};
    const kp = agent.knowledge_profile || {};
    const scenario = data.scenario || {};
    const ctx = scenario.case_context || {};
    const conversation = data.conversation || {};

    const subs = {
        question_count: String(questionCount),
        role: str(agent.role),
        authority: str(agent.authority),
        relationship_to_student: str(agent.relationship_to_student),
        objectives_yaml_block: yamlBlock(agent.objectives),
        concerns_yaml_block: yamlBlock(agent.concerns),
        decision_criteria_yaml_block: yamlBlock(agent.decision_criteria),
        constraints_yaml_block: yamlBlock(agent.constraints),
        interaction_style: str(agent.interaction_style),
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

    return template.replace(/\{\{(\w+)\}\}/g, (m, key) =>
        Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : m
    );
}

// Strips optional ```json fence; throws if not valid JSON.
export function parseQuestionsJSON(raw) {
    const trimmed = String(raw || "").trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
    const body = fenced ? fenced[1].trim() : trimmed;
    return JSON.parse(body);
}

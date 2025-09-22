export function buildQuestionMasterPrompt(normalizedText, assignment, rubric) {
  const objectives = Array.isArray(assignment?.objectives)
    ? assignment.objectives.map((obj, idx) => `${idx + 1}. ${obj}`).join("\n")
    : JSON.stringify(assignment?.objectives || {});
  const rubricCriteria = Array.isArray(rubric?.criteria)
    ? rubric.criteria.map(crit => `- (${crit.id}) ${crit.name} — peso ${crit.weight}`).join("\n")
    : JSON.stringify(rubric?.criteria || {});

  return [
    "Você é um monitor pedagógico. Crie um roteiro de perguntas avaliativas a partir do trabalho enviado.",
    "Use somente as informações disponíveis no texto normalizado do trabalho. Não suponha leituras externas nem use web.",
    "O roteiro deve ter entre 10 e 14 perguntas ordenadas do nível mais básico ao mais avançado, encadeando conceitos.",
    "Garanta diversidade: inclua questões de recordação/compreensão, aplicação, crítica/verificação e extrapolação.",
    "Para cada pergunta, traga também um campo rationale_esperado com 2 a 4 linhas, destinado apenas ao professor (não será mostrado ao aluno).",
    "Evite qualquer menção explícita ao rationale nas perguntas e não inclua comentários fora do JSON.",
    "Siga o esquema JSON abaixo e responda exclusivamente com JSON válido:",
    "{\n  \"perguntas\": [\n    {\n      \"id\": \"Q1\",\n      \"tipo\": \"compreensao|aplicacao|critica|verificacao\",\n      \"texto\": \"…\",\n      \"rationale_esperado\": \"…\"\n    }\n  ]\n}",
    "Detalhes da atividade:",
    `Título: ${assignment?.title || "(sem título)"}`,
    "Objetivos:",
    objectives,
    "Critérios da rubrica:",
    rubricCriteria,
    "Texto normalizado do trabalho (use-o integralmente como base):",
    normalizedText
  ].join("\n\n");
}

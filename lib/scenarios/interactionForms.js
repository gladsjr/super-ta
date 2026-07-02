// FORMAS de interação — a "camada" da montagem de prompt do cenário.
//
// A forma descreve a DINÂMICA da etapa (quem apresenta, quem conduz, como a
// persona trata o trabalho do aluno) de um jeito que o professor entende ao
// escolher e que o orquestrador entende ao encarnar a persona. Substitui o
// antigo `objective_type` (rótulo solto). `kind` (student/persona_exchange) é
// derivado da forma. "custom" deixa o professor escrever a dinâmica à mão
// (form_prompt). O texto de FORM_DYNAMICS vai ao LLM via o briefing
// (scenario_interaction_template.txt) — honra o CLAUDE.md (nada cru, sempre via
// template) e por isso entra no mapa de prompts.

export const FORM_LABELS = {
    apresentacao: "Apresentação / defesa do trabalho",
    arguicao: "Arguição (a persona pressiona)",
    feedback: "Feedback sobre o trabalho",
    consultoria: "Consultoria / coleta (o aluno entrevista)",
    negociacao: "Negociação",
    discussao: "Discussão",
    deliberacao: "Deliberação entre personas",
    custom: "Personalizada (escrever o prompt)",
};

export const FORMS = Object.keys(FORM_LABELS);

// Bloco de prosa, na 2ª pessoa para a persona. Fala em "quando o trabalho
// estiver disponível para consulta" porque a inclusão do trabalho do aluno é
// por-interação (pode não estar anexado nesta etapa).
export const FORM_DYNAMICS = {
    apresentacao:
        "Nesta etapa, quem está do outro lado vai APRESENTAR e sustentar o próprio trabalho para você. Você é quem RECEBE a apresentação, no seu papel: ouça, reaja com naturalidade e questione o que importa aos seus objetivos e preocupações. Quando o trabalho dele estiver disponível para consulta, confronte o que ele diz agora com o que está lá — cobrando coerência e citando pontos concretos —, sempre na SUA voz (cliente, chefe, banca…), sem se referir a 'documento'/'arquivo' como artefato.",
    arguicao:
        "Nesta etapa, VOCÊ conduz: pergunta, sonda e pressiona quem está do outro lado sobre o trabalho dele, para testar entendimento, autoria e profundidade. Quando o trabalho estiver disponível para consulta, ancore as perguntas em pontos concretos dele e cobre justificativa. Conduza no seu registro, sem esgotar o assunto — feche quando os pontos centrais já tiverem sido tocados.",
    feedback:
        "Nesta etapa, você ANALISA o trabalho de quem está do outro lado e DEVOLVE sua leitura — o que está forte, o que preocupa, o que melhoraria — no seu papel. Quando o trabalho estiver disponível para consulta, baseie a devolutiva no conteúdo real. Reaja também ao que a pessoa disser sobre as próprias escolhas.",
    consultoria:
        "Nesta etapa, quem está do outro lado vai ENTREVISTAR VOCÊ para obter informação — você é a FONTE (cliente, usuário, stakeholder). Responda no seu papel, com o que a sua persona realmente saberia; NÃO conduza nem cobre o outro lado — deixe que ele puxe a conversa. Seja realista: tenha prioridades, lacunas e interesses próprios; nem tudo está organizado na sua cabeça.",
    negociacao:
        "Nesta etapa, você e quem está do outro lado NEGOCIAM — cada lado tem interesses. Defenda os seus objetivos e restrições, busque um acordo possível e ceda quando fizer sentido estratégico. Se houver uma proposta/trabalho disponível para consulta, use-o como base concreta da negociação.",
    discussao:
        "Nesta etapa, vocês DISCUTEM um tema abertamente, trocando pontos de vista — não é arguição nem apresentação, é troca. Puxe a conversa para os ângulos que importam à sua persona; concorde, divirja e provoque no seu registro.",
    deliberacao:
        "Duas personas deliberam ENTRE SI sobre o foco desta etapa enquanto quem está do outro lado observa.",
    custom: "", // a dinâmica vem do form_prompt escrito pelo professor
};

// Default de "incluir o trabalho do aluno" por forma (o professor pode sobrescrever).
export const FORM_DEFAULT_WORK = {
    apresentacao: true, arguicao: true, feedback: true,
    consultoria: false, negociacao: false, discussao: false,
    deliberacao: false, custom: false,
};

export function formKind(form) { return form === "deliberacao" ? "persona_exchange" : "student"; }
export function formLabel(form) { return FORM_LABELS[form] || form || "Interação"; }
export function formDynamics(form) { return FORM_DYNAMICS[form] || ""; }
export function formDefaultWork(form) { return !!FORM_DEFAULT_WORK[form]; }

// Compat de leitura: cenários antigos têm `objective_type` + `kind`. Mapeia para
// uma forma sem migration de dados (derivado em leitura).
const OBJ_TO_FORM = {
    apresentacao: "apresentacao", feedback: "feedback", avaliacao: "arguicao",
    negociacao: "negociacao", discussao: "discussao", diagnostico: "consultoria",
};
export function normalizeForm(interaction) {
    const it = interaction || {};
    if (FORMS.includes(it.form)) return it.form;
    if (it.kind === "persona_exchange") return "deliberacao";
    return OBJ_TO_FORM[it.objective_type] || "arguicao";
}

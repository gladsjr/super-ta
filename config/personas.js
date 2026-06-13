// Catálogo único das personas de entrevistador.
//
// Fonte de verdade dos rótulos AMIGÁVEIS ao professor (nome, ícone, resumo,
// "quando usar") para cada template `config/interviewers/*.yaml`. Reusado por:
//   - a galeria do modo Simples no painel do professor (static/professor.html);
//   - o enriquecimento de GET /interviewers/templates (routes/work.js);
//   - o cartão recommend_persona do assistente e o modal de coerência (label).
//
// O `filename` casa byte-a-byte com o nome do template no banco
// (interviewer_templates) e nos arquivos de seed. Adicionar uma persona nova =
// uma entrada aqui + o template correspondente. O conteúdo do YAML continua
// sendo a única fonte de verdade da AGENDA; este catálogo é só apresentação.

export const PERSONAS = [
    {
        filename: "Teacher Assistant.yaml",
        label: "Arguição acadêmica",
        icon: "🎓",
        summary: "Banca acadêmica que cobra autoria e domínio do conteúdo.",
        when_to_use: "Padrão para trabalhos de disciplina. Foca em autoria e entendimento, sem enquadramento profissional.",
    },
    {
        filename: "Business Owner.yaml",
        label: "Cliente de consultoria",
        icon: "💼",
        summary: "Cliente avaliando se a proposta sustenta uma decisão real.",
        when_to_use: "Trabalhos enquadrados como consultoria: estudos, recomendações e propostas para um cliente.",
    },
    {
        filename: "Hiring Manager.yaml",
        label: "Entrevista de emprego",
        icon: "🧑‍💼",
        summary: "Gestor técnico testando o candidato na etapa final.",
        when_to_use: "Trabalhos em formato de processo seletivo ou defesa de competências técnicas.",
    },
    {
        filename: "Investor.yaml",
        label: "Investidor",
        icon: "📈",
        summary: "Investidor ouvindo um pitch para decidir se aloca capital.",
        when_to_use: "Pitches de negócio, planos de startup e oportunidades de investimento.",
    },
    {
        filename: "Executive Sponsor.yaml",
        label: "Sponsor executivo",
        icon: "🏢",
        summary: "Executivo decidindo orçamento e prioridade de uma iniciativa interna.",
        when_to_use: "Propostas internas que disputam orçamento e prioridade dentro da organização.",
    },
    {
        filename: "Journalist.yaml",
        label: "Jornalista",
        icon: "📰",
        summary: "Repórter investigando os fatos e a base das afirmações.",
        when_to_use: "Trabalhos com forte dimensão pública ou argumentativa que precisam resistir à verificação.",
    },
];

const BY_FILENAME = new Map(PERSONAS.map(p => [p.filename, p]));

// Ordem canônica de exibição (índice no catálogo). Templates fora do catálogo
// ficam no fim.
export const PERSONA_ORDER = new Map(PERSONAS.map((p, i) => [p.filename, i]));

// Meta de exibição para QUALQUER filename — inclusive um template fora do
// catálogo (ex.: persona customizada adicionada direto no banco): devolve um
// fallback neutro derivado do filename, nunca null.
export function personaDisplay(filename) {
    const meta = BY_FILENAME.get(filename);
    if (meta) return meta;
    const label = String(filename || "").replace(/\.ya?ml$/i, "");
    return { filename, label, icon: "🗂", summary: "", when_to_use: "" };
}

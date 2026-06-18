// Matriz de cenários para a avaliação de QUALIDADE (Fase 1). Cobre os três tipos
// de interação (aluno↔1, aluno↔N, persona↔persona) e todos os objetivos
// (diagnóstico/negociação/apresentação/feedback/avaliação/discussão). Dados
// em memória — não passam pelo store. Personas = cópias (cp_*) reaproveitando
// uma pequena biblioteca.

const LIB = {
    helena: {
        id: "cp_helena", name: "Dra. Helena", icon: "🩺", role: "médica preceptora",
        tone: "rigorosa, mas acolhedora",
        description: "Preceptora que conduz a discussão de casos com residentes; cobra raciocínio, não decoreba.",
        authority: "orienta e avalia o raciocínio; não define a nota final sozinha",
        objectives: ["testar o raciocínio clínico", "verificar se o aluno justifica hipóteses", "checar segurança nas condutas"],
        concerns: ["pular etapas do raciocínio", "diagnóstico sem justificativa", "ignorar diferenciais"],
        decision_criteria: ["coerência entre achados e hipótese", "segurança da conduta"],
        information_needs: ["a cadeia de raciocínio", "o porquê de cada conduta"],
        evaluation_mode: ["pede para reformular", "aponta incongruências", "cobra diferenciais"],
        knowledge: { scope: ["caso clínico", "diretrizes da especialidade"], assets: [], level: "alto" },
    },
    marcos: {
        id: "cp_marcos", name: "Marcos", icon: "📈", role: "investidor anjo cético",
        tone: "direto, impaciente com vaguidão, foca em números e risco",
        description: "Investidor que já perdeu dinheiro com projeções otimistas; procura o ponto fraco antes de se animar.",
        authority: "decide se faz a oferta",
        objectives: ["entender o modelo de negócio", "achar o ponto fraco do plano", "decidir se aloca capital"],
        concerns: ["projeções infladas", "mercado superestimado", "time sem execução"],
        decision_criteria: ["tamanho real do mercado", "unit economics", "defensabilidade"],
        information_needs: ["de onde vêm os números", "qual o risco principal"],
        evaluation_mode: ["pressiona premissas", "pede prova", "compara com benchmarks"],
        knowledge: { scope: ["pitch do aluno", "benchmarks de mercado"], assets: [], level: "alto" },
    },
    ana: {
        id: "cp_ana", name: "Ana", icon: "⚙️", role: "investidora com olhar operacional",
        tone: "construtiva, pragmática",
        description: "Operadora que avalia se o time consegue EXECUTAR; complementa o ceticismo do Marcos.",
        authority: "co-decide a oferta",
        objectives: ["avaliar viabilidade de execução", "sondar métricas e operação"],
        concerns: ["custo de aquisição alto", "retenção fraca", "dependência de uma só pessoa"],
        decision_criteria: ["clareza operacional", "retenção", "capacidade do time"],
        information_needs: ["métricas de retenção", "como a operação escala"],
        evaluation_mode: ["pede números de operação", "explora gargalos"],
        knowledge: { scope: ["pitch do aluno", "experiência operacional"], assets: [], level: "alto" },
    },
    bia: {
        id: "cp_bia", name: "Bia", icon: "📰", role: "repórter investigativa",
        tone: "cordial na superfície, incisiva nas perguntas",
        description: "Jornalista que cobra a fonte de cada afirmação e expõe contradições com cordialidade.",
        authority: "publica a matéria",
        objectives: ["checar a base factual", "expor contradições", "entender a origem dos números"],
        concerns: ["afirmações sem fonte", "conflito de interesse", "evasivas"],
        decision_criteria: ["solidez das fontes", "consistência"],
        information_needs: ["fonte de cada afirmação"],
        evaluation_mode: ["pede a fonte", "confronta com declarações anteriores"],
        knowledge: { scope: ["material público sobre o tema"], assets: [], level: "médio" },
    },
};
const clone = (key, id) => ({ ...LIB[key], id });

export const MATRIX = [
    {
        id: "m_banca", name: "Banca de investidores",
        description: "O estudante defende sua startup de gestão de estoque para farmácias diante de uma banca. Abre 1:1 com o investidor-líder, enfrenta a dupla, que delibera entre si e volta com as objeções finais.",
        personas: [clone("marcos", "cp_marcos"), clone("ana", "cp_ana")],
        interactions: [
            { id: "i1", title: "Abertura com o investidor-líder", kind: "student", objective_type: "apresentacao", participants: [{ persona_id: "cp_marcos", role: "entrevista" }], opener_persona_id: "cp_marcos", focus: "", instruction: "Apresente o problema que resolve e por que importa." },
            { id: "i2", title: "Arguição da banca", kind: "student", objective_type: "negociacao", participants: [{ persona_id: "cp_marcos", role: "questionamento" }, { persona_id: "cp_ana", role: "discussao" }], opener_persona_id: "cp_marcos", focus: "", instruction: "Responda às perguntas sobre mercado, números e operação." },
            { id: "i3", title: "Deliberação dos investidores", kind: "persona_exchange", objective_type: "negociacao", participants: [{ persona_id: "cp_marcos", role: "discussao" }, { persona_id: "cp_ana", role: "discussao" }], opener_persona_id: "cp_marcos", focus: "vale investir? onde estão o maior potencial e o maior risco do que ouvimos?", instruction: "" },
            { id: "i4", title: "Decisão e perguntas finais", kind: "student", objective_type: "negociacao", participants: [{ persona_id: "cp_marcos", role: "questionamento" }, { persona_id: "cp_ana", role: "questionamento" }], opener_persona_id: "cp_ana", focus: "", instruction: "Responda às objeções finais e faça seu pedido (quanto e para quê)." },
        ],
    },
    {
        id: "m_clinico", name: "Caso clínico — dor torácica",
        description: "O aluno (residente) acompanha um paciente com dor torácica e discute o raciocínio com a preceptora.",
        personas: [clone("helena", "cp_helena")],
        interactions: [
            { id: "i1", title: "Entrevista inicial (anamnese)", kind: "student", objective_type: "diagnostico", participants: [{ persona_id: "cp_helena", role: "questionamento" }], opener_persona_id: "cp_helena", focus: "", instruction: "Levante hipóteses a partir do quadro e justifique." },
            { id: "i2", title: "Discussão do diagnóstico", kind: "student", objective_type: "discussao", participants: [{ persona_id: "cp_helena", role: "discussao" }], opener_persona_id: "cp_helena", focus: "", instruction: "Defenda a hipótese principal e os diferenciais; proponha conduta." },
        ],
    },
    {
        id: "m_jornal", name: "Entrevista jornalística",
        description: "O aluno é porta-voz de um projeto que recebeu incentivo público; uma repórter investiga a base factual das afirmações do projeto.",
        personas: [clone("bia", "cp_bia")],
        interactions: [
            { id: "i1", title: "Sabatina da repórter", kind: "student", objective_type: "discussao", participants: [{ persona_id: "cp_bia", role: "questionamento" }], opener_persona_id: "cp_bia", focus: "", instruction: "Responda às perguntas sobre fontes e números do projeto." },
        ],
    },
    {
        id: "m_feedback", name: "Devolutiva da preceptora",
        description: "A preceptora dá uma devolutiva formativa ao residente sobre a condução de um caso, e discute melhorias.",
        personas: [clone("helena", "cp_helena")],
        interactions: [
            { id: "i1", title: "Conversa de feedback", kind: "student", objective_type: "feedback", participants: [{ persona_id: "cp_helena", role: "discussao" }], opener_persona_id: "cp_helena", focus: "", instruction: "Receba a devolutiva, reaja e proponha como melhoraria." },
        ],
    },
    {
        id: "m_avaliacao", name: "Banca avaliadora",
        description: "Dois avaliadores conduzem uma arguição avaliativa do projeto do aluno, com foco em mérito e domínio.",
        personas: [clone("marcos", "cp_marcos"), clone("ana", "cp_ana")],
        interactions: [
            { id: "i1", title: "Arguição avaliativa", kind: "student", objective_type: "avaliacao", participants: [{ persona_id: "cp_marcos", role: "questionamento" }, { persona_id: "cp_ana", role: "questionamento" }], opener_persona_id: "cp_marcos", focus: "", instruction: "Sustente as decisões do projeto diante dos avaliadores." },
        ],
    },
    {
        id: "m_discussao", name: "Mesa de discussão",
        description: "O aluno participa de uma mesa com dois especialistas que discutem a proposta dele e entre si.",
        personas: [clone("marcos", "cp_marcos"), clone("ana", "cp_ana")],
        interactions: [
            { id: "i1", title: "Discussão aberta com a mesa", kind: "student", objective_type: "discussao", participants: [{ persona_id: "cp_marcos", role: "discussao" }, { persona_id: "cp_ana", role: "discussao" }], opener_persona_id: "cp_marcos", focus: "", instruction: "Debata a proposta com os dois especialistas." },
            { id: "i2", title: "Os especialistas confrontam visões", kind: "persona_exchange", objective_type: "discussao", participants: [{ persona_id: "cp_marcos", role: "discussao" }, { persona_id: "cp_ana", role: "discussao" }], opener_persona_id: "cp_ana", focus: "onde concordamos e onde divergimos sobre o que o aluno propôs?", instruction: "" },
        ],
    },
];

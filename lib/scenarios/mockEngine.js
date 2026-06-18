// Motor de orquestração MULTIAGENTE — versão MOCK (zero LLM, zero token).
//
// Dado um cenário + suas personas + o transcript, produz os próximos turnos de
// forma ROTEIRIZADA: cada persona "fala" derivando a linha do seu papel, tom,
// objetivos e preocupações, reagindo à última fala do aluno. Suporta:
//   - aluno ↔ 1 persona;
//   - aluno ↔ N personas (rodízio de quem conduz o turno);
//   - troca persona ↔ persona (apartes em que as personas comentam o aluno
//     entre si), quando o cenário liga `persona_exchange`.
//
// É deliberadamente determinístico-por-turno (varia pelo índice do turno e por
// um hash da fala do aluno) para a validação ser reproduzível. Quando a fase
// mock for aprovada, este arquivo é o ponto onde se troca a geração roteirizada
// por chamadas reais ao orquestrador — a interface (openingTurns/respond) fica.

function hashStr(s) {
    let h = 0;
    for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
const pick = (arr, n) => (arr && arr.length ? arr[n % arr.length] : "");

function entry(persona, kind, text, extra = {}) {
    return { speaker: persona ? persona.id : "system", name: persona?.name ?? null, icon: persona?.icon ?? null, kind, text, ...extra };
}

// Reação curta à fala do aluno (mock — não interpreta de verdade; sinaliza
// escuta e varia para não repetir).
function reactionTo(text, n) {
    if (!text || !text.trim()) return "";
    const acks = ["Entendi.", "Certo.", "Ok, anotei.", "Interessante.", "Hm, deixa eu pensar.", "Boa."];
    const len = text.trim().length;
    const depth = len > 220 ? " Você trouxe bastante coisa —" : len < 40 ? " Foi curto —" : "";
    return pick(acks, n + (hashStr(text) % acks.length)) + depth;
}

// Transforma um objetivo da persona numa provocação/pergunta.
function probeFrom(objective, n) {
    const obj = objective || "entender melhor o seu ponto";
    const frames = [
        `voltando ao que me importa — ${obj}: o que você diria?`,
        `ainda não me convenci sobre isto: ${obj}. Desenvolve?`,
        `deixa eu te provocar — ${obj}. Como você sustenta isso?`,
        `preciso fechar um ponto: ${obj}. Me dá um exemplo concreto?`,
        `e quanto a ${obj}? Não passe por cima disso.`,
    ];
    return pick(frames, n);
}

// Uma linha de uma persona reagindo ao aluno e perseguindo um objetivo.
export function personaLine(persona, _scenario, studentText, turnIdx) {
    const obj = pick(persona.objectives, turnIdx);
    const concern = pick(persona.concerns, turnIdx + 1);
    const react = reactionTo(studentText, turnIdx);
    const probe = probeFrom(obj, turnIdx);
    const worry = (turnIdx % 3 === 2 && concern) ? ` Confesso que me preocupa ${concern}.` : "";
    return `${react} ${capitalize(probe)}${worry}`.trim();
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

const ROLE_LABEL = { entrevista: "conduz a entrevista", discussao: "participa da discussão", questionamento: "questiona e provoca" };

// Abertura do cenário: enquadramento (system) + fala de abertura do opener.
export function openingTurns(scenario, personasById) {
    const out = [];
    const participants = (scenario.participants || []).map(p => personasById[p.persona_id]).filter(Boolean);
    const names = participants.map(p => `${p.icon || ""} ${p.name}`.trim()).join(participants.length === 2 ? " e " : ", ");
    const async = scenario.interaction_mode === "assincrono";
    out.push(entry(null, "frame",
        `${objectiveLabel(scenario.objective_type)} · ${async ? "assíncrono (responda quando puder)" : "síncrono (ao vivo)"}` +
        (participants.length ? ` · com ${names}` : "") +
        `\n${scenario.context || ""}`.trimEnd()));
    const opener = personasById[scenario.opener_persona_id] || participants[0];
    if (opener) {
        const role = (scenario.participants.find(p => p.persona_id === opener.id) || {}).role;
        out.push(entry(opener, "persona",
            `Olá, sou ${opener.name}, ${opener.role}. ${roleIntro(role)} ${scenario.student_task || "Vamos começar — pode falar."}`));
    }
    return out;
}

function roleIntro(role) {
    if (role === "entrevista") return "Vou te entrevistar.";
    if (role === "discussao") return "Vou discutir com você (e com a banca).";
    return "Vou te questionar de perto.";
}

// Próximos turnos após uma fala do aluno. Rodízio de quem conduz; aparte
// persona↔persona quando ligado e há ≥2 personas.
export function respond(scenario, personasById, transcript, studentText) {
    const out = [];
    const participants = (scenario.participants || []).map(p => ({ ...p, persona: personasById[p.persona_id] })).filter(p => p.persona);
    if (participants.length === 0) return out;
    // Quantos turnos de aluno já houve → define o índice de rodízio.
    const studentTurns = transcript.filter(t => t.kind === "student").length;
    const lead = participants[studentTurns % participants.length];
    out.push(entry(lead.persona, "persona", personaLine(lead.persona, scenario, studentText, studentTurns), { role: lead.role }));

    // Aparte: as personas comentam o aluno entre si (a cada 2 turnos do aluno).
    if (scenario.persona_exchange && participants.length >= 2 && studentTurns % 2 === 1) {
        const other = participants.find(p => p.persona.id !== lead.persona.id);
        if (other) {
            const judgA = pick(["achei promissor, mas raso", "não me convenceu ainda", "tem ponto, falta prova", "evasivo no que importa"], studentTurns);
            const objB = pick(other.persona.objectives, studentTurns);
            out.push(entry(lead.persona, "aside", `${other.persona.name}, o que você achou? Pra mim, ${judgA}.`, { to: other.persona.id, role: lead.role }));
            out.push(entry(other.persona, "aside", `Concordo em parte. Ainda me falta ${objB} — vou puxar isso na próxima.`, { to: lead.persona.id, role: other.role }));
        }
    }
    return out;
}

export function objectiveLabel(t) {
    return ({
        diagnostico: "Diagnóstico",
        negociacao: "Negociação",
        apresentacao: "Apresentação",
        feedback: "Feedback",
        avaliacao: "Avaliação",
        discussao: "Discussão",
    })[t] || (t || "Cenário");
}

export const OBJECTIVE_TYPES = ["diagnostico", "negociacao", "apresentacao", "feedback", "avaliacao", "discussao"];
export const PARTICIPANT_ROLES = ["entrevista", "discussao", "questionamento"];
export const INTERACTION_MODES = ["sincrono", "assincrono"];
export { ROLE_LABEL };

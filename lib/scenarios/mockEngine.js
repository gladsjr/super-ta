// Motor de orquestração MULTIAGENTE — versão MOCK (zero LLM, zero token).
//
// Modelo: um CENÁRIO tem uma SEQUÊNCIA ORDENADA de interações. Cada interação é
//   - "student": aluno ↔ persona(s) — rodízio de quem conduz; ou
//   - "persona_exchange": duas personas conversam entre si sobre um "foco"
//     (o aluno observa e avança).
// O motor produz turnos roteirizados derivando as falas do papel/tom/objetivos
// das personas. Determinístico-por-turno para a validação ser reproduzível.
// Quando o mock for aprovado, troca-se a geração roteirizada por chamadas reais
// ao orquestrador — a interface (scenarioFrame/interactionStart/respond) fica.

import { formLabel, normalizeForm } from "./interactionForms.js";

function hashStr(s) { let h = 0; for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const pick = (arr, n) => (arr && arr.length ? arr[n % arr.length] : "");
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export function entry(persona, kind, text, extra = {}) {
    return { speaker: persona ? persona.id : "system", name: persona?.name ?? null, icon: persona?.icon ?? null, kind, text, ...extra };
}

// Cabeçalho de uma interação (entrada kind:"interaction"). Extraído para o
// liveEngine reusar EXATAMENTE o mesmo formato que o mock. it_kind (não "kind"):
// o spread de extra sobrescreveria o kind:"interaction" do cabeçalho, quebrando
// o render (t.kind==='interaction') e a detecção de fronteira de turnos.
export function interactionHeader(interaction, personasById, idx, total) {
    const parts = (interaction.participants || []).map(p => personasById[p.persona_id]).filter(Boolean);
    const names = parts.map(p => `${p.icon || ""} ${p.name}`.trim()).join(parts.length === 2 ? " e " : ", ");
    return entry(null, "interaction", `Interação ${idx + 1} de ${total} — ${interaction.title}`, {
        idx, total, it_kind: interaction.kind,
        meta: `${formLabel(normalizeForm(interaction))}${interaction.kind === "persona_exchange" ? " · personas conversam" : ""}${names ? ` · ${names}` : ""}`,
    });
}

function reactionTo(text, n) {
    if (!text || !text.trim()) return "";
    const acks = ["Entendi.", "Certo.", "Ok, anotei.", "Interessante.", "Hm, deixa eu pensar.", "Boa."];
    const len = text.trim().length;
    const depth = len > 220 ? " Você trouxe bastante coisa —" : len < 40 ? " Foi curto —" : "";
    return pick(acks, n + (hashStr(text) % acks.length)) + depth;
}
function probeFrom(objective, n) {
    const obj = objective || "entender melhor o seu ponto";
    const frames = [
        `voltando ao que me importa — ${obj}: o que você diria?`,
        `ainda não me convenci sobre isto: ${obj}. Desenvolve?`,
        `deixa eu te provocar — ${obj}. Como você sustenta isso?`,
        `preciso fechar um ponto: ${obj}. Me dá um exemplo concreto?`,
    ];
    return pick(frames, n);
}

export function personaLine(persona, studentText, turnIdx) {
    const obj = pick(persona.objectives, turnIdx);
    const concern = pick(persona.concerns, turnIdx + 1);
    const react = reactionTo(studentText, turnIdx);
    const worry = (turnIdx % 3 === 2 && concern) ? ` Confesso que me preocupa ${concern}.` : "";
    return `${react} ${cap(probeFrom(obj, turnIdx))}${worry}`.trim();
}

// Fala de abertura roteirizada conforme a FORMA da etapa (não o papel do
// participante): em consultoria QUEM conduz é o aluno, então a persona se coloca
// como fonte — não diz "vou te entrevistar". Espelha a DINÂMICA de cada forma.
function formIntro(form) {
    switch (form) {
        case "apresentacao": return "Pode apresentar — estou ouvindo.";
        case "arguicao": return "Vou te questionar de perto.";
        case "feedback": return "Deixa eu te passar minha leitura.";
        case "consultoria": return "Pode perguntar; te conto o que sei.";
        case "negociacao": return "Vamos conversar e ver se chegamos a um acordo.";
        case "discussao": return "Vamos discutir.";
        default: return "Pode começar.";
    }
}

// Frame do CENÁRIO (abertura geral).
export function scenarioFrame(scenario) {
    return entry(null, "scenario", `${scenario.name}${scenario.description ? `\n${scenario.description}` : ""}`);
}

// Início de uma INTERAÇÃO: cabeçalho (com posição na ordem) + conteúdo de
// abertura. Em "student", a persona que abre se apresenta + dá a instrução. Em
// "persona_exchange", as duas personas trocam falas sobre o foco (aluno observa).
export function interactionStart(interaction, personasById, idx, total) {
    const out = [];
    const parts = (interaction.participants || []).map(p => personasById[p.persona_id]).filter(Boolean);
    out.push(interactionHeader(interaction, personasById, idx, total));

    if (interaction.kind === "persona_exchange") {
        const [a, b] = parts;
        if (a && b) {
            const focus = interaction.focus || "o que ouvimos";
            out.push(entry(a, "aside", `${b.name}, sobre ${focus} — pra mim, ${pick(["tem potencial mas falta prova", "o risco principal pesa", "fiquei dividido"], 0)}.`, { to: b.id }));
            out.push(entry(b, "aside", `${cap(pick(["concordo em parte", "vejo diferente", "complemento"], 0))}. Meu receio é ${pick(b.concerns, 0) || "a execução"}.`, { to: a.id }));
            out.push(entry(a, "aside", `Justo. Ainda me falta ${pick(a.objectives, 0) || "fechar o ponto central"} — dá pra avançar com ressalvas.`, { to: b.id }));
        }
        return out;
    }

    const opener = personasById[interaction.opener_persona_id] || parts[0];
    if (opener) {
        const form = normalizeForm(interaction);
        // Tira pontuação final do papel para não duplicar o ponto ("...energia solar.. ").
        const roleText = String(opener.role || "").replace(/[.\s]+$/, "");
        out.push(entry(opener, "persona", `Olá, sou ${opener.name}${roleText ? `, ${roleText}` : ""}. ${formIntro(form)} ${interaction.instruction || "Pode começar."}`.trim()));
    }
    return out;
}

// Resposta das personas a uma fala do aluno (só interações "student"). Conta os
// turnos do aluno DESTA interação (entradas após o último cabeçalho de interação)
// para o rodízio de quem conduz.
export function respond(interaction, personasById, transcript, studentText) {
    if (interaction.kind !== "student") return [];
    const parts = (interaction.participants || []).map(p => ({ ...p, persona: personasById[p.persona_id] })).filter(p => p.persona);
    if (!parts.length) return [];
    let studentTurns = 0;
    for (let i = transcript.length - 1; i >= 0; i--) {
        if (transcript[i].kind === "interaction") break;
        if (transcript[i].kind === "student") studentTurns++;
    }
    const lead = parts[(studentTurns - 1 + parts.length) % parts.length];
    return [entry(lead.persona, "persona", personaLine(lead.persona, studentText, studentTurns), { role: lead.role })];
}

export function objectiveLabel(t) {
    return ({ diagnostico: "Diagnóstico", negociacao: "Negociação", apresentacao: "Apresentação", feedback: "Feedback", avaliacao: "Avaliação", discussao: "Discussão" })[t] || (t || "Interação");
}

// Avaliação MOCK do PDF perante o cenário (coerência roteirizada, sem LLM).
export function evaluatePdfMock(scenario) {
    const n = (scenario.interactions || []).length;
    const personas = new Set();
    (scenario.interactions || []).forEach(i => (i.participants || []).forEach(p => personas.add(p.persona_id)));
    return {
        verdict: "coerente",
        notes: [
            `O enunciado cobre ${n} interação(ões) e ${personas.size} persona(s) configuradas.`,
            "Mock: a checagem real (LLM) confrontará o texto do PDF com objetivo, ordem das interações e papéis das personas.",
        ],
    };
}

export const OBJECTIVE_TYPES = ["diagnostico", "negociacao", "apresentacao", "feedback", "avaliacao", "discussao"];
export const PARTICIPANT_ROLES = ["fonte", "entrevista", "discussao", "questionamento"];
export const INTERACTION_KINDS = ["student", "persona_exchange"];
export const ROLE_LABEL = { fonte: "é a fonte (você responde; o aluno conduz)", entrevista: "conduz a entrevista", discussao: "participa da discussão", questionamento: "questiona e provoca" };
// Papel default coerente com a forma: em consultoria/coleta a persona é a FONTE
// (o aluno conduz); nas demais, "questiona e provoca" segue como neutro.
export function defaultRoleForForm(form) { return form === "consultoria" ? "fonte" : "questionamento"; }

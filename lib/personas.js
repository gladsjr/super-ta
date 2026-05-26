// Persona generator for the interviewer agent. Picks a name (gender-balanced)
// and a Brazilian city of origin uniformly at random. Used at /start so each
// session gets a stable persona for the lifetime of the interview.

const FEMALE_NAMES = [
    "Ana", "Beatriz", "Camila", "Larissa", "Juliana", "Patrícia",
    "Fernanda", "Carolina", "Letícia", "Mariana", "Renata", "Cristina",
    "Isabela", "Aline", "Rafaela",
];

const MALE_NAMES = [
    "João", "Pedro", "Lucas", "Rafael", "Bruno", "Diego",
    "Gustavo", "Rodrigo", "Leandro", "Vinícius", "Marcelo", "André",
    "Thiago", "Daniel", "Gabriel",
];

const CITIES = [
    "Belém", "Manaus", "São Luís", "Fortaleza", "Recife", "Salvador",
    "Brasília", "Goiânia", "Belo Horizonte", "Vitória", "Rio de Janeiro",
    "São Paulo", "Curitiba", "Florianópolis", "Porto Alegre",
    "Campo Grande", "Cuiabá",
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

// Retorna um nome aleatório para o gênero pedido. Usado pela UI do professor
// como sugestão default e para o botão "🎲 Sortear outro".
export function pickRandomName(gender) {
    if (gender === "f") return pick(FEMALE_NAMES);
    if (gender === "m") return pick(MALE_NAMES);
    const g = Math.random() < 0.5 ? "f" : "m";
    return pick(g === "f" ? FEMALE_NAMES : MALE_NAMES);
}

// Três níveis de prioridade para a persona:
// 1. `overrides` — vem do works.interviewer_name/gender configurado pelo
//    professor; é o caminho preferido. Quando ambos preenchidos, ignora
//    voiceGender (a checagem de coerência voz↔gênero é responsabilidade
//    da UI do professor, que avisa mas não bloqueia).
// 2. `voiceGender` — modo áudio sem override do professor. Restringe o
//    sorteio para evitar dissonância de uma voz feminina se apresentar com
//    nome masculino, ou vice-versa.
// 3. Sorteio balanceado — modo texto sem override.
// Cidade segue aleatória em qualquer caminho (não há configuração pra ela
// hoje; é "reserva" para quando o aluno pergunta de onde o entrevistador é).
export function pickPersona({ voiceGender, overrides } = {}) {
    if (overrides && overrides.name && (overrides.gender === "f" || overrides.gender === "m")) {
        return { name: overrides.name, gender: overrides.gender, city: pick(CITIES) };
    }
    let gender;
    if (voiceGender === "f" || voiceGender === "m") {
        gender = voiceGender;
    } else {
        gender = Math.random() < 0.5 ? "f" : "m";
    }
    const name = pick(gender === "f" ? FEMALE_NAMES : MALE_NAMES);
    const city = pick(CITIES);
    return { name, gender, city };
}

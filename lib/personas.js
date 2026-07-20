// Persona generator for the interviewer agent. Picks a name (gender-balanced)
// and a Brazilian city of origin. Used at /start. Com `seed` (o work_token), a
// escolha é DETERMINÍSTICA por trabalho: o mesmo trabalho apresenta sempre o
// mesmo entrevistador a todos os alunos (antes o nome era sorteado por sessão e
// "trocava" entre entrevistas do mesmo trabalho). Sem seed, sorteio aleatório.

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

// Hash determinístico de string (FNV-1a). Mesma string → mesmo inteiro. Serve
// para SEMEAR a persona por TRABALHO: dado o work_token como seed, todas as
// entrevistas do mesmo trabalho recebem o MESMO entrevistador (nome/cidade),
// em vez de um sorteio novo por sessão (que deixava a persona "trocando de
// nome" entre alunos do mesmo trabalho).
function hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Escolhe um item de `list` de forma DETERMINÍSTICA a partir de (seed, salt).
function pickSeeded(list, seed, salt) {
    return list[hashStr(`${seed}::${salt}`) % list.length];
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
// `seed` (ex.: work_token): quando presente, o sorteio vira DETERMINÍSTICO por
// trabalho — todas as entrevistas do mesmo trabalho recebem o mesmo nome/cidade
// (a persona não "troca de nome" entre alunos). Sem seed, mantém o sorteio
// aleatório por sessão (comportamento legado). A cidade é "reserva" (só citada
// se o aluno perguntar de onde o entrevistador é), mas também fica estável.
export function pickPersona({ voiceGender, overrides, seed } = {}) {
    const cityFor = () => (seed ? pickSeeded(CITIES, seed, "city") : pick(CITIES));
    if (overrides && overrides.name && (overrides.gender === "f" || overrides.gender === "m")) {
        return { name: overrides.name, gender: overrides.gender, city: cityFor() };
    }
    let gender;
    if (voiceGender === "f" || voiceGender === "m") {
        gender = voiceGender;
    } else if (seed) {
        gender = (hashStr(`${seed}::gender`) & 1) ? "f" : "m";
    } else {
        gender = Math.random() < 0.5 ? "f" : "m";
    }
    const names = gender === "f" ? FEMALE_NAMES : MALE_NAMES;
    const name = seed ? pickSeeded(names, seed, "name") : pick(names);
    const city = cityFor();
    return { name, gender, city };
}

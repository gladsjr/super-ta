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

export function pickPersona() {
    const gender = Math.random() < 0.5 ? "f" : "m";
    const name = pick(gender === "f" ? FEMALE_NAMES : MALE_NAMES);
    const city = pick(CITIES);
    return { name, gender, city };
}

// Armazenamento do sistema de CENÁRIOS MULTIAGENTE (fase mock).
//
// Deliberadamente em JSON sob data/scenarios/, NÃO no Postgres: enquanto o
// desenho está em validação, o schema muda muito e não vale uma migration; e
// assim o protótipo roda mesmo sem banco. Trocar por Postgres depois da
// validação é direto (mesma interface). Dados pequenos → lê/escreve o arquivo
// inteiro.
//
// Duas coleções de DEFINIÇÃO (a "linguagem de definição dividida"):
//   - personas:  personagens reutilizáveis (papel, objetivos, tom, saber).
//   - scenarios: encontros que REFERENCIAM personas, com objetivo, papéis por
//                participante, modo síncrono/assíncrono e troca persona↔persona.
// E uma coleção de execução (runs) com o transcript do mock.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PROJECT_ROOT } from "../config.js";
import { SEED_PERSONAS, SEED_SCENARIOS } from "./seed.js";

const DIR = path.join(PROJECT_ROOT, "data", "scenarios");
const FILES = {
    personas: path.join(DIR, "personas.json"),
    scenarios: path.join(DIR, "scenarios.json"),
    runs: path.join(DIR, "runs.json"),
};

const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

async function ensureDir() {
    await fs.mkdir(DIR, { recursive: true });
}

async function readColl(name) {
    try {
        const raw = await fs.readFile(FILES[name], "utf8");
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (err) {
        if (err.code === "ENOENT") return null; // ainda não semeado
        throw err;
    }
}

async function writeColl(name, arr) {
    await ensureDir();
    const tmp = FILES[name] + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(arr, null, 2), "utf8");
    await fs.rename(tmp, FILES[name]);
}

// Semeia exemplos na primeira vez (para o professor ter o que explorar). Só
// roda quando o arquivo não existe — não sobrescreve o que o professor criar.
async function load(name) {
    let arr = await readColl(name);
    if (arr === null) {
        const seed = name === "personas" ? SEED_PERSONAS : name === "scenarios" ? SEED_SCENARIOS : [];
        arr = seed.map(x => ({ ...x }));
        await writeColl(name, arr);
    }
    return arr;
}

// ---- Personas ----
export async function listPersonas() { return load("personas"); }
export async function getPersona(id) { return (await load("personas")).find(p => p.id === id) || null; }
export async function savePersona(input) {
    const arr = await load("personas");
    const now = new Date().toISOString();
    if (input.id) {
        const i = arr.findIndex(p => p.id === input.id);
        if (i === -1) throw Object.assign(new Error("persona não encontrada"), { code: "NOT_FOUND" });
        arr[i] = { ...arr[i], ...input, updated_at: now };
        await writeColl("personas", arr);
        return arr[i];
    }
    const persona = { ...input, id: shortId("p"), created_at: now, updated_at: now };
    arr.push(persona);
    await writeColl("personas", arr);
    return persona;
}
export async function deletePersona(id) {
    const arr = await load("personas");
    await writeColl("personas", arr.filter(p => p.id !== id));
}

// ---- Cenários ----
export async function listScenarios() { return load("scenarios"); }
export async function getScenario(id) { return (await load("scenarios")).find(s => s.id === id) || null; }
export async function saveScenario(input) {
    const arr = await load("scenarios");
    const now = new Date().toISOString();
    if (input.id) {
        const i = arr.findIndex(s => s.id === input.id);
        if (i === -1) throw Object.assign(new Error("cenário não encontrado"), { code: "NOT_FOUND" });
        arr[i] = { ...arr[i], ...input, updated_at: now };
        await writeColl("scenarios", arr);
        return arr[i];
    }
    const scenario = { ...input, id: shortId("s"), created_at: now, updated_at: now };
    arr.push(scenario);
    await writeColl("scenarios", arr);
    return scenario;
}
export async function deleteScenario(id) {
    const arr = await load("scenarios");
    await writeColl("scenarios", arr.filter(s => s.id !== id));
}

// ---- Runs (execução mock) ----
export async function getRun(id) { return (await load("runs")).find(r => r.id === id) || null; }
export async function createRun(scenarioId) {
    const arr = await load("runs");
    const run = { id: shortId("r"), scenario_id: scenarioId, transcript: [], turn: 0, created_at: new Date().toISOString() };
    arr.push(run);
    await writeColl("runs", arr);
    return run;
}
export async function saveRun(run) {
    const arr = await load("runs");
    const i = arr.findIndex(r => r.id === run.id);
    if (i === -1) arr.push(run); else arr[i] = run;
    await writeColl("runs", arr);
    return run;
}

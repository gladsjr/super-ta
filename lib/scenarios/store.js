// Armazenamento do sistema de CENÁRIOS MULTIAGENTE (fase mock).
//
// Deliberadamente em JSON sob data/scenarios/, NÃO no Postgres: enquanto o
// desenho está em validação, o schema muda muito e não vale uma migration; e
// assim o protótipo roda mesmo sem banco. Trocar por Postgres depois da
// validação é direto (mesma interface). Dados pequenos → lê/escreve o arquivo
// inteiro.
//
// Coleções:
//   - templates: biblioteca reutilizável de personas (definição completa,
//     incluindo voz e gênero). Fonte para instanciar personas em cenários.
//   - scenarios: o cenário (explicação geral + PDF + personas ESCOLHIDAS,
//     embutidas como cópias editáveis + sequência ordenada de interações).
//   - runs: execução mock (transcript).

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PROJECT_ROOT } from "../config.js";
import { SEED_TEMPLATES, SEED_SCENARIOS } from "./seed.js";

const DIR = path.join(PROJECT_ROOT, "data", "scenarios");
const FILES = {
    templates: path.join(DIR, "templates.json"),
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
    const data = JSON.stringify(arr, null, 2);
    // Escrita direta com retry: tmp+rename dava EPERM no Windows quando o repo
    // está em pasta sincronizada (Dropbox/antivírus travam o destino). Para um
    // store de mock, escrita direta com retry em lock transitório é suficiente.
    for (let attempt = 1; attempt <= 4; attempt++) {
        try { await fs.writeFile(FILES[name], data, "utf8"); return; }
        catch (err) {
            if ((err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") && attempt < 4) {
                await new Promise(r => setTimeout(r, 60 * attempt));
                continue;
            }
            throw err;
        }
    }
}

// Semeia exemplos na primeira vez (para o professor ter o que explorar). Só
// roda quando o arquivo não existe — não sobrescreve o que o professor criar.
async function load(name) {
    let arr = await readColl(name);
    if (arr === null) {
        const seed = name === "templates" ? SEED_TEMPLATES : name === "scenarios" ? SEED_SCENARIOS : [];
        arr = seed.map(x => ({ ...x }));
        await writeColl(name, arr);
    }
    return arr;
}

// ---- Templates (biblioteca reutilizável) ----
export async function listTemplates() { return load("templates"); }
export async function getTemplate(id) { return (await load("templates")).find(t => t.id === id) || null; }
export async function saveTemplate(input) {
    const arr = await load("templates");
    const now = new Date().toISOString();
    if (input.id) {
        const i = arr.findIndex(t => t.id === input.id);
        if (i === -1) throw Object.assign(new Error("template não encontrado"), { code: "NOT_FOUND" });
        arr[i] = { ...arr[i], ...input, updated_at: now };
        await writeColl("templates", arr);
        return arr[i];
    }
    const tpl = { ...input, id: shortId("t"), created_at: now, updated_at: now };
    arr.push(tpl);
    await writeColl("templates", arr);
    return tpl;
}
export async function deleteTemplate(id) {
    const arr = await load("templates");
    await writeColl("templates", arr.filter(t => t.id !== id));
}

// ---- Cenários (personas escolhidas + interações ordenadas, embutidas) ----
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

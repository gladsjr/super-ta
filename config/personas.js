// Catálogo de apresentação das personas de entrevistador.
//
// FONTE ÚNICA: o bloco `display:` de cada `config/interviewers/*.yaml`. Este
// módulo lê esses arquivos no boot e monta o catálogo amigável ao professor
// (nome, ícone, resumo, "quando usar", ordem). Antes essa meta vivia numa lista
// fixa aqui — o que desincronizava do template ao renomear/editar (ex.: o
// arquivo virou "Startup Investor.yaml" e a lista continuava "Investor.yaml").
// Agora renomear/editar UMA persona é só o YAML dela; interface, ordenação e a
// validação dos agentes acompanham sozinhas.
//
// O `display` NÃO vai ao LLM: o renderer da agenda (lib/interviewerAgenda.js)
// lê apenas `agent`/`scenario`/`conversation`. O conteúdo do YAML segue sendo a
// única fonte de verdade da AGENDA; este bloco é só apresentação.
//
// Reusado por:
//   - a galeria do modo Simples no painel do professor (static/professor.html
//     via GET /interviewers/templates em routes/work.js);
//   - a lista de personas prontas e a validação nos agentes de configuração
//     (agents/ConfigAssistantAgent.js, agents/EnunciadoCoherenceAgent.js).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const INTERVIEWERS_DIR = fileURLToPath(new URL("./interviewers/", import.meta.url));

function str(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
}

// Lê os display de cada YAML em disco, ordenado por `display.order` (sem ordem
// definida vai para o fim, depois alfabético pelo filename).
function loadPersonas() {
    let files;
    try {
        files = fs.readdirSync(INTERVIEWERS_DIR).filter(f => /\.ya?ml$/i.test(f));
    } catch {
        return [];
    }
    const out = [];
    for (const filename of files) {
        let data;
        try {
            data = yaml.load(fs.readFileSync(path.join(INTERVIEWERS_DIR, filename), "utf8")) || {};
        } catch {
            continue;
        }
        const d = data.display || {};
        out.push({
            filename,
            label: str(d.label) || filename.replace(/\.ya?ml$/i, ""),
            icon: str(d.icon) || "🗂",
            summary: str(d.summary),
            when_to_use: str(d.when_to_use),
            order: Number.isFinite(d.order) ? Number(d.order) : 999,
        });
    }
    out.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.filename.localeCompare(b.filename)));
    return out;
}

export const PERSONAS = loadPersonas();

const BY_FILENAME = new Map(PERSONAS.map(p => [p.filename, p]));

// Ordem canônica de exibição (índice no catálogo já ordenado). Templates fora do
// catálogo (ex.: persona customizada só no banco) ficam no fim.
export const PERSONA_ORDER = new Map(PERSONAS.map((p, i) => [p.filename, i]));

// Meta de exibição para QUALQUER filename — inclusive um template fora do
// catálogo: devolve um fallback neutro derivado do filename, nunca null.
export function personaDisplay(filename) {
    const meta = BY_FILENAME.get(filename);
    if (meta) return meta;
    const label = String(filename || "").replace(/\.ya?ml$/i, "");
    return { filename, label, icon: "🗂", summary: "", when_to_use: "" };
}

// --- Helpers para os prompts/validação dos agentes (mesma fonte, sem drift) ---

// Filenames válidos, na ordem canônica: ["Teacher Assistant.yaml", ...].
export function personaFilenames() {
    return PERSONAS.map(p => p.filename);
}

// Lista entre aspas para injetar em prompt: "A.yaml", "B.yaml", ...
export function personaFilenamesQuoted() {
    return PERSONAS.map(p => `"${p.filename}"`).join(", ");
}

// Bullets para o prompt do assistente: um por persona, com filename + rótulo + resumo.
export function personaChoiceLines() {
    return PERSONAS.map(p => `   - "${p.filename}" — ${p.label}: ${p.summary}`).join("\n");
}

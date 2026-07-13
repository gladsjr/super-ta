import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./util.js";

function requiredString(value, field, file) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: campo obrigatorio ${field}`);
}

export function validateCase(item, file = "caso") {
    requiredString(item?.id, "id", file);
    requiredString(item?.area, "area", file);
    requiredString(item?.large_area, "large_area", file);
    requiredString(item?.persona?.description, "persona.description", file);
    requiredString(item?.assignment, "assignment", file);
    requiredString(item?.student_work, "student_work", file);
    if (!Array.isArray(item?.turns) || item.turns.length === 0) throw new Error(`${file}: turns deve ser uma lista nao vazia`);
    const seen = new Set();
    for (const turn of item.turns) {
        requiredString(turn?.id, "turns[].id", file);
        if (seen.has(turn.id)) throw new Error(`${file}: turno duplicado ${turn.id}`);
        seen.add(turn.id);
        if (!Array.isArray(turn.history)) throw new Error(`${file}: ${turn.id}.history deve ser lista`);
        requiredString(turn.student_message, `${turn.id}.student_message`, file);
        requiredString(turn.canonical_response, `${turn.id}.canonical_response`, file);
        if (!Array.isArray(turn.expected_intents) || !turn.expected_intents.length) throw new Error(`${file}: ${turn.id}.expected_intents deve ser lista nao vazia`);
    }
    return item;
}

export function loadCases(casesDir, selectedIds = []) {
    const files = fs.readdirSync(casesDir).filter((name) => name.endsWith(".json")).sort();
    const wanted = new Set(selectedIds);
    const cases = files.map((name) => {
        const file = path.join(casesDir, name);
        const item = validateCase(JSON.parse(fs.readFileSync(file, "utf8")), file);
        return { ...item, source_file: name, document_hash: sha256({ assignment: item.assignment, student_work: item.student_work }) };
    }).filter((item) => !wanted.size || wanted.has(item.id));
    if (!cases.length) throw new Error("nenhum caso selecionado");
    if (wanted.size) {
        const found = new Set(cases.map((item) => item.id));
        const missing = [...wanted].filter((id) => !found.has(id));
        if (missing.length) throw new Error(`casos nao encontrados: ${missing.join(", ")}`);
    }
    return cases;
}

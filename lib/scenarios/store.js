// Armazenamento do sistema de CENÁRIOS MULTIAGENTE — Postgres.
//
// Saiu do JSON (data/scenarios/) para o banco na productionização. Mesma
// INTERFACE de antes (as rotas não mudam). Tabelas (migration 021):
//   - scenario_templates: biblioteca reutilizável de personas (data JSONB).
//   - scenarios: o cenário (name/description colunas + personas/interactions/pdf/
//     coherence em data JSONB; opcionalmente ligado a um work via work_id).
//   - scenario_runs: execução (transcript, memory, avaliação, notas).
// JSONB é parseado para objeto na leitura pelo driver; na escrita, serializamos.
// Semeia exemplos na primeira vez (tabela vazia), como o store antigo fazia.

import { randomUUID } from "crypto";
import { pool } from "../../auth.js";
import { SEED_TEMPLATES, SEED_SCENARIOS } from "./seed.js";

const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const J = (v) => JSON.stringify(v ?? null);

// ---- Templates ----
async function seedTemplatesIfEmpty() {
    const { rows } = await pool.query("SELECT 1 FROM scenario_templates LIMIT 1");
    if (rows.length) return;
    for (const t of SEED_TEMPLATES) {
        await pool.query("INSERT INTO scenario_templates (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [t.id, J(t)]);
    }
}
export async function listTemplates() {
    await seedTemplatesIfEmpty();
    const { rows } = await pool.query("SELECT data FROM scenario_templates ORDER BY created_at, id");
    return rows.map(r => r.data);
}
export async function getTemplate(id) {
    const { rows } = await pool.query("SELECT data FROM scenario_templates WHERE id = $1", [id]);
    return rows[0]?.data || null;
}
export async function saveTemplate(input) {
    const now = new Date().toISOString();
    if (input.id) {
        const cur = await getTemplate(input.id);
        if (!cur) throw Object.assign(new Error("template não encontrado"), { code: "NOT_FOUND" });
        const data = { ...cur, ...input, updated_at: now };
        await pool.query("UPDATE scenario_templates SET data = $2, updated_at = now() WHERE id = $1", [input.id, J(data)]);
        return data;
    }
    const id = shortId("t");
    const data = { ...input, id, created_at: now, updated_at: now };
    await pool.query("INSERT INTO scenario_templates (id, data) VALUES ($1, $2)", [id, J(data)]);
    return data;
}
export async function deleteTemplate(id) { await pool.query("DELETE FROM scenario_templates WHERE id = $1", [id]); }

// ---- Cenários ----
function rowToScenario(row) {
    const d = row.data || {};
    return {
        id: row.id, work_id: row.work_id, name: row.name, description: row.description,
        personas: d.personas || [], interactions: d.interactions || [],
        pdf: d.pdf ?? null, coherence: d.coherence ?? null,
        created_at: row.created_at, updated_at: row.updated_at,
    };
}
async function seedScenariosIfEmpty() {
    const { rows } = await pool.query("SELECT 1 FROM scenarios LIMIT 1");
    if (rows.length) return;
    for (const s of SEED_SCENARIOS) {
        const data = { personas: s.personas || [], interactions: s.interactions || [], pdf: s.pdf ?? null, coherence: s.coherence ?? null };
        await pool.query("INSERT INTO scenarios (id, work_id, name, description, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
            [s.id, null, s.name, s.description || "", J(data)]);
    }
}
async function writeScenario(s) {
    const data = { personas: s.personas || [], interactions: s.interactions || [], pdf: s.pdf ?? null, coherence: s.coherence ?? null };
    await pool.query(
        `INSERT INTO scenarios (id, work_id, name, description, data) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET work_id = EXCLUDED.work_id, name = EXCLUDED.name, description = EXCLUDED.description, data = EXCLUDED.data, updated_at = now()`,
        [s.id, s.work_id ?? null, s.name || "", s.description || "", J(data)]);
}
export async function listScenarios() {
    await seedScenariosIfEmpty();
    const { rows } = await pool.query("SELECT id, work_id, name, description, data, created_at, updated_at FROM scenarios ORDER BY created_at, id");
    return rows.map(rowToScenario);
}
export async function getScenario(id) {
    const { rows } = await pool.query("SELECT id, work_id, name, description, data, created_at, updated_at FROM scenarios WHERE id = $1", [id]);
    return rows[0] ? rowToScenario(rows[0]) : null;
}
export async function saveScenario(input) {
    const now = new Date().toISOString();
    if (input.id) {
        const cur = await getScenario(input.id);
        if (!cur) throw Object.assign(new Error("cenário não encontrado"), { code: "NOT_FOUND" });
        // merge preserva o que o input não traz (ex.: PDF salva só {pdf,coherence}).
        const merged = { ...cur, ...input, updated_at: now };
        await writeScenario(merged);
        return merged;
    }
    const s = { ...input, id: shortId("s"), created_at: now, updated_at: now };
    await writeScenario(s);
    return s;
}
export async function deleteScenario(id) { await pool.query("DELETE FROM scenarios WHERE id = $1", [id]); }
// Cenário anexado a um trabalho (fluxo do aluno por token). Um por work.
export async function getScenarioByWork(workId) {
    const { rows } = await pool.query("SELECT id, work_id, name, description, data, created_at, updated_at FROM scenarios WHERE work_id = $1", [workId]);
    return rows[0] ? rowToScenario(rows[0]) : null;
}
export async function attachScenarioToWork(scenarioId, workId) {
    await pool.query("UPDATE scenarios SET work_id = $2, updated_at = now() WHERE id = $1", [scenarioId, workId]);
}

// ---- Runs ----
function rowToRun(row) {
    return {
        id: row.id, scenario_id: row.scenario_id, submission_id: row.submission_id,
        mode: row.mode, interaction_index: row.interaction_index, transcript: row.transcript || [],
        memory: row.memory ?? null, evaluation_json: row.evaluation_json ?? null,
        grades_json: row.grades_json ?? null, done: row.done,
    };
}
export async function getRun(id) {
    const { rows } = await pool.query("SELECT * FROM scenario_runs WHERE id = $1", [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
}
// Run ativo de uma submissão (resume do fluxo do aluno). O mais recente.
export async function getRunBySubmission(submissionId) {
    const { rows } = await pool.query("SELECT * FROM scenario_runs WHERE submission_id = $1 ORDER BY created_at DESC LIMIT 1", [submissionId]);
    return rows[0] ? rowToRun(rows[0]) : null;
}
export async function createRun(scenarioId, submissionId = null) {
    const id = shortId("r");
    await pool.query("INSERT INTO scenario_runs (id, scenario_id, submission_id) VALUES ($1, $2, $3)", [id, scenarioId, submissionId]);
    return { id, scenario_id: scenarioId, submission_id: submissionId, mode: "mock", interaction_index: 0, transcript: [], memory: null, evaluation_json: null, grades_json: null, done: false };
}
export async function saveRun(run) {
    await pool.query(
        `UPDATE scenario_runs SET mode = $2, interaction_index = $3, transcript = $4, memory = $5,
            evaluation_json = $6, grades_json = $7, done = $8, updated_at = now() WHERE id = $1`,
        [run.id, run.mode || "mock", run.interaction_index || 0, J(run.transcript || []),
         run.memory ? J(run.memory) : null, run.evaluation_json ? J(run.evaluation_json) : null,
         run.grades_json ? J(run.grades_json) : null, !!run.done]);
    return run;
}

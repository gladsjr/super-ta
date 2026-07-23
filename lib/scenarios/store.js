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
import { interviewerPersonaTemplates } from "./importInterviewerPersonas.js";
import { builtinPersonaTemplates } from "./builtinPersonas.js";
import { normalizeForm, formKind, FORM_DEFAULT_WORK } from "./interactionForms.js";

// Compat de leitura: garante que toda interação carregue `form` (derivado do
// antigo objective_type/kind quando ausente), `includes_student_work` (default
// pela forma) e `kind` (derivado da forma). Sem migration de dados.
function normInteraction(it) {
    const form = normalizeForm(it);
    return {
        ...it, form,
        form_prompt: it.form_prompt || "",
        includes_student_work: typeof it.includes_student_work === "boolean" ? it.includes_student_work : !!FORM_DEFAULT_WORK[form],
        kind: it.kind || formKind(form),
        // Limite de tempo da etapa (minutos). Opcional: null = sem cronômetro.
        time_limit_min: typeof it.time_limit_min === "number" && it.time_limit_min > 0 ? it.time_limit_min : null,
        // Ao ENTRAR nesta etapa, tranca (definitivamente) o retorno às anteriores.
        lock_previous: !!it.lock_previous,
        // Informações que as personas detêm e o aluno não — reveladas só nesta
        // etapa, se a outra ponta perguntar/conduzir. [{text, persona_ids:[...]}]
        private_info: Array.isArray(it.private_info) ? it.private_info : [],
        // Artefato (PDF) da etapa: material que o aluno lê e a persona consulta
        // (file_search). {filename, file_id, vector_store_id, uploaded_at} | null.
        artifact: it.artifact || null,
    };
}

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
// As 6 personas da entrevista (config/interviewers/*.yaml) entram na biblioteca
// SEMPRE (upsert idempotente, 1x por processo) — não só quando a tabela está
// vazia —, para que bancos já semeados também as recebam. Editáveis depois.
let _ivPersonasSeeded = false;
async function seedInterviewerPersonasOnce() {
    if (_ivPersonasSeeded) return;
    _ivPersonasSeeded = true;
    for (const t of interviewerPersonaTemplates()) {
        await pool.query("INSERT INTO scenario_templates (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [t.id, J(t)]);
    }
}
// Personas-template BUILT-IN (ex.: Vendedor de soluções): mesmo padrão das da
// entrevista — upsert idempotente por id estável, 1x por processo, p/ alcançar
// bancos já semeados (inclusive produção). Ver builtinPersonas.js.
let _builtinPersonasSeeded = false;
async function seedBuiltinPersonasOnce() {
    if (_builtinPersonasSeeded) return;
    _builtinPersonasSeeded = true;
    for (const t of builtinPersonaTemplates()) {
        await pool.query("INSERT INTO scenario_templates (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [t.id, J(t)]);
    }
}
export async function listTemplates() {
    await seedTemplatesIfEmpty();
    await seedInterviewerPersonasOnce();
    await seedBuiltinPersonasOnce();
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
        // Regras globais do cenário (valem em todas as etapas): o que NUNCA é
        // abordado e as premissas que aluno e personas compartilham.
        out_of_scope: d.out_of_scope ?? "", premissas: d.premissas ?? "",
        personas: d.personas || [], interactions: (d.interactions || []).map(normInteraction),
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
    const data = { personas: s.personas || [], interactions: s.interactions || [], pdf: s.pdf ?? null, coherence: s.coherence ?? null, out_of_scope: s.out_of_scope ?? "", premissas: s.premissas ?? "" };
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
        student_work: row.student_work_json || {},
        // Aceite de leitura dos artefatos por interação (migration 025): { iid: iso }.
        artifact_acks: row.artifact_acks || {},
        // Cockpit do professor (migration 024): devolutiva persistida + publicação.
        devolutiva_json: row.devolutiva_json ?? null,
        evaluation_published_at: row.evaluation_published_at ?? null,
        grade_published_at: row.grade_published_at ?? null,
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
    return { id, scenario_id: scenarioId, submission_id: submissionId, mode: "mock", interaction_index: 0, transcript: [], memory: null, evaluation_json: null, grades_json: null, done: false, student_work: {}, artifact_acks: {}, devolutiva_json: null, evaluation_published_at: null, grade_published_at: null };
}
// Lista, para um TRABALHO de cenário, uma linha por submissão com o ÚLTIMO run e
// o estado derivado (para o cockpit do professor). Junta `submissions` (identidade
// do aluno) com o `scenario_runs` mais recente daquela submissão.
export async function listScenarioRunsForWork(workId) {
    const { rows } = await pool.query(
        `SELECT s.submission_token, s.student_label, s.is_blocked, s.is_test, s.created_at,
                r.id AS run_id, r.interaction_index, r.done,
                (r.evaluation_json IS NOT NULL) AS has_evaluation,
                (r.devolutiva_json IS NOT NULL) AS has_devolutiva,
                (r.grades_json IS NOT NULL) AS has_grades,
                (r.grades_json->>'final') AS grade_final,
                r.evaluation_published_at, r.grade_published_at,
                (SELECT count(*) FROM jsonb_array_elements(coalesce(r.transcript,'[]'::jsonb)) e WHERE e->>'kind' = 'student') AS student_turns
           FROM submissions s
           LEFT JOIN LATERAL (
             SELECT * FROM scenario_runs r2 WHERE r2.submission_id = s.id ORDER BY r2.created_at DESC LIMIT 1
           ) r ON true
          WHERE s.work_id = $1
          ORDER BY s.created_at`,
        [workId]);
    return rows.map(x => ({
        submission_token: x.submission_token,
        student_label: x.student_label,
        is_blocked: x.is_blocked,
        is_test: x.is_test,
        run_id: x.run_id,
        // Status do run: não iniciado / em andamento / concluído.
        status: !x.run_id ? "pending" : (x.done ? "completed" : "in_progress"),
        interaction_index: x.interaction_index,
        student_turns: Number(x.student_turns || 0),
        has_evaluation: !!x.has_evaluation,
        has_devolutiva: !!x.has_devolutiva,
        has_grades: !!x.has_grades,
        grade_final: x.grade_final != null ? Number(x.grade_final) : null,
        evaluation_published_at: x.evaluation_published_at || null,
        grade_published_at: x.grade_published_at || null,
    }));
}

export async function saveRun(run) {
    await pool.query(
        `UPDATE scenario_runs SET mode = $2, interaction_index = $3, transcript = $4, memory = $5,
            evaluation_json = $6, grades_json = $7, done = $8, student_work_json = $9,
            devolutiva_json = $10, evaluation_published_at = $11, grade_published_at = $12,
            artifact_acks = $13, updated_at = now() WHERE id = $1`,
        [run.id, run.mode || "mock", run.interaction_index || 0, J(run.transcript || []),
         run.memory ? J(run.memory) : null, run.evaluation_json ? J(run.evaluation_json) : null,
         run.grades_json ? J(run.grades_json) : null, !!run.done, J(run.student_work || {}),
         run.devolutiva_json ? J(run.devolutiva_json) : null,
         run.evaluation_published_at || null, run.grade_published_at || null,
         J(run.artifact_acks || {})]);
    return run;
}

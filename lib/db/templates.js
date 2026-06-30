// Templates de entrevistador (compartilhados, substituem config/interviewers/*.yaml).
// Parte do split de lib/db.js (ver lib/db.js, que é o barrel que re-exporta
// tudo). SQL e lógica preservados verbatim do módulo monolítico original.

import { pool } from "../../auth.js";

// ---------------------------------------------------------------------
// Interviewer templates (shared, replaces config/interviewers/*.yaml)
// ---------------------------------------------------------------------

export async function listInterviewerTemplates() {
    const r = await pool.query(
        "SELECT filename FROM interviewer_templates ORDER BY filename ASC"
    );
    return r.rows.map(row => ({ filename: row.filename }));
}

export async function getInterviewerTemplate(filename) {
    const r = await pool.query(
        "SELECT yaml_text FROM interviewer_templates WHERE filename = $1",
        [filename]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].yaml_text;
}

export async function upsertInterviewerTemplate(filename, yamlText) {
    await pool.query(`
      INSERT INTO interviewer_templates (filename, yaml_text)
      VALUES ($1, $2)
      ON CONFLICT (filename) DO UPDATE
        SET yaml_text = EXCLUDED.yaml_text, updated_at = now()
    `, [filename, yamlText]);
}

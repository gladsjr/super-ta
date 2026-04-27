// One-shot migration: walks the legacy filesystem layout (data/works/* and
// config/interviewers/*.yaml) and copies everything into PostgreSQL.
// Idempotent — re-runs skip rows that already exist by token/filename.
//
// Run after applying schema.sql:
//   npm run db:migrate-fs

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../auth.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const WORKS_ROOT = path.join(PROJECT_ROOT, "data", "works");
const TEMPLATES_DIR = path.join(PROJECT_ROOT, "config", "interviewers");

const DIR_RE = /^([0-9a-f]{12})-(.+)$/i;
function parseDirName(name) {
    const m = DIR_RE.exec(name);
    return m ? { token: m[1].toLowerCase(), label: m[2] } : null;
}

function readBlob(p) {
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
function readText(p) {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

let counts = { templates: 0, templatesSkipped: 0, works: 0, worksSkipped: 0, submissions: 0, submissionsSkipped: 0 };

async function migrateInterviewerTemplates() {
    if (!fs.existsSync(TEMPLATES_DIR)) {
        console.log(`(no templates dir at ${TEMPLATES_DIR})`);
        return;
    }
    for (const filename of fs.readdirSync(TEMPLATES_DIR)) {
        if (!/\.ya?ml$/i.test(filename)) continue;
        const yamlText = fs.readFileSync(path.join(TEMPLATES_DIR, filename), "utf8");
        const exists = await pool.query(
            "SELECT id FROM interviewer_templates WHERE filename = $1",
            [filename]
        );
        if (exists.rowCount > 0) {
            counts.templatesSkipped++;
            console.log(`  template skip (exists): ${filename}`);
            continue;
        }
        await pool.query(
            "INSERT INTO interviewer_templates (filename, yaml_text) VALUES ($1, $2)",
            [filename, yamlText]
        );
        counts.templates++;
        console.log(`  template inserted: ${filename}`);
    }
}

async function migrateWorks() {
    if (!fs.existsSync(WORKS_ROOT)) {
        console.log(`(no works dir at ${WORKS_ROOT})`);
        return;
    }
    for (const e of fs.readdirSync(WORKS_ROOT, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const parsed = parseDirName(e.name);
        if (!parsed) {
            console.log(`  skip (unparseable dir): ${e.name}`);
            continue;
        }
        const workFullPath = path.join(WORKS_ROOT, e.name);
        await migrateOneWork(parsed.token, parsed.label, workFullPath);
    }
}

async function migrateOneWork(workToken, label, workFullPath) {
    const exists = await pool.query("SELECT id FROM works WHERE work_token = $1", [workToken]);
    let workId;
    if (exists.rowCount > 0) {
        workId = exists.rows[0].id;
        counts.worksSkipped++;
        console.log(`  work skip (exists): ${workToken} "${label}"`);
    } else {
        const enunciadoPath = path.join(workFullPath, "enunciado.pdf");
        const enunciadoBuf = readBlob(enunciadoPath);
        const enunciadoFilename = enunciadoBuf ? "enunciado.pdf" : null;
        const interviewerYaml = readText(path.join(workFullPath, "interviewer.yaml"));
        const r = await pool.query(
            `INSERT INTO works (work_token, name, enunciado_pdf, enunciado_filename, interviewer_yaml)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [workToken, label, enunciadoBuf, enunciadoFilename, interviewerYaml]
        );
        workId = r.rows[0].id;
        counts.works++;
        console.log(`  work inserted: ${workToken} "${label}" enunciado=${!!enunciadoBuf} interviewer=${!!interviewerYaml}`);
    }

    const subsRoot = path.join(workFullPath, "submissions");
    if (!fs.existsSync(subsRoot)) return;
    for (const se of fs.readdirSync(subsRoot, { withFileTypes: true })) {
        if (!se.isDirectory()) continue;
        const sParsed = parseDirName(se.name);
        if (!sParsed) {
            console.log(`    skip (unparseable sub): ${se.name}`);
            continue;
        }
        await migrateOneSubmission(sParsed.token, sParsed.label, workId, path.join(subsRoot, se.name));
    }
}

async function migrateOneSubmission(subToken, label, workId, subPath) {
    const exists = await pool.query(
        "SELECT id FROM submissions WHERE submission_token = $1",
        [subToken]
    );
    if (exists.rowCount > 0) {
        counts.submissionsSkipped++;
        console.log(`    submission skip (exists): ${subToken} "${label}"`);
        return;
    }

    // Find the student PDF: any file other than conversation.json / final_report.json
    let studentBuf = null;
    let studentFilename = null;
    if (fs.existsSync(subPath)) {
        for (const f of fs.readdirSync(subPath)) {
            if (f === "conversation.json" || f === "conversation.json.tmp" || f === "final_report.json") continue;
            const full = path.join(subPath, f);
            try {
                if (fs.statSync(full).isFile()) {
                    studentBuf = fs.readFileSync(full);
                    studentFilename = f;
                    break;
                }
            } catch { /* ignore */ }
        }
    }
    const conversationJson = readText(path.join(subPath, "conversation.json"));
    const finalReportJson = readText(path.join(subPath, "final_report.json"));

    await pool.query(
        `INSERT INTO submissions (submission_token, work_id, student_label, student_pdf, student_pdf_filename, conversation_json, final_report_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [subToken, workId, label, studentBuf, studentFilename, conversationJson, finalReportJson]
    );
    counts.submissions++;
    console.log(`    submission inserted: ${subToken} "${label}" pdf=${!!studentBuf} conv=${!!conversationJson} final=${!!finalReportJson}`);
}

async function main() {
    console.log(`Migrating from ${PROJECT_ROOT} to PostgreSQL...`);
    console.log("\n[interviewer_templates]");
    await migrateInterviewerTemplates();
    console.log("\n[works + submissions]");
    await migrateWorks();
    console.log("\n--- summary ---");
    console.log(`templates inserted: ${counts.templates}, skipped: ${counts.templatesSkipped}`);
    console.log(`works     inserted: ${counts.works}, skipped: ${counts.worksSkipped}`);
    console.log(`submissions inserted: ${counts.submissions}, skipped: ${counts.submissionsSkipped}`);
    await pool.end();
}

main().catch(err => {
    console.error("migration failed:", err);
    process.exit(1);
});

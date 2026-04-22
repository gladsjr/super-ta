import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(LIB_DIR, "..");
export const WORKS_ROOT = path.join(PROJECT_ROOT, "data", "works");

// Token = 6 random bytes as lowercase hex (12 chars).
export function newToken() {
    return crypto.randomBytes(6).toString("hex");
}

const TOKEN_RE = /^[0-9a-f]{12}$/i;
// Folder name convention: <12hex>-<label>. The separator is the first "-";
// label itself may contain further "-".
const DIR_RE = /^([0-9a-f]{12})-(.+)$/i;
const FORBIDDEN_LABEL_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

export function sanitizeLabel(raw) {
    const label = String(raw ?? "").trim();
    if (!label) throw new Error("label required");
    if (label.length > 80) throw new Error("label too long (max 80 chars)");
    if (FORBIDDEN_LABEL_CHARS.test(label)) throw new Error('label contains forbidden characters (< > : " / \\ | ? *)');
    if (label.endsWith(".") || label.endsWith(" ")) throw new Error("label cannot end with '.' or space");
    return label;
}

export function parseDirName(dirName) {
    const m = DIR_RE.exec(dirName);
    if (!m) return null;
    return { token: m[1].toLowerCase(), label: m[2] };
}

export function findWorkDir(workToken) {
    if (!TOKEN_RE.test(workToken)) return null;
    if (!fs.existsSync(WORKS_ROOT)) return null;
    const target = workToken.toLowerCase();
    for (const e of fs.readdirSync(WORKS_ROOT, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const parsed = parseDirName(e.name);
        if (parsed && parsed.token === target) {
            return { dirName: e.name, fullPath: path.join(WORKS_ROOT, e.name), label: parsed.label };
        }
    }
    return null;
}

export function findSubmissionDirInWork(workFullPath, subToken) {
    if (!TOKEN_RE.test(subToken)) return null;
    const subsRoot = path.join(workFullPath, "submissions");
    if (!fs.existsSync(subsRoot)) return null;
    const target = subToken.toLowerCase();
    for (const e of fs.readdirSync(subsRoot, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const parsed = parseDirName(e.name);
        if (parsed && parsed.token === target) {
            return { dirName: e.name, fullPath: path.join(subsRoot, e.name), label: parsed.label };
        }
    }
    return null;
}

// Derived status: any file other than final_report.json means the student
// has engaged (upload or chat artifact).
export function submissionStatus(submissionFullPath) {
    if (fs.existsSync(path.join(submissionFullPath, "final_report.json"))) return "finalized";
    if (!fs.existsSync(submissionFullPath)) return "pending";
    const files = fs.readdirSync(submissionFullPath);
    if (files.some(f => f !== "final_report.json")) return "in_progress";
    return "pending";
}

export function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
    next();
}

export function requireWorkToken(req, res, next) {
    const workToken = String(req.params.workToken || "").toLowerCase();
    const found = findWorkDir(workToken);
    if (!found) return res.status(404).json({ error: "work not found" });
    const assignmentPdfPath = path.join(found.fullPath, "enunciado.pdf");
    req.work = {
        work_token: workToken,
        name: found.label,
        dir_name: found.dirName,
        full_path: found.fullPath,
        assignment_pdf: fs.existsSync(assignmentPdfPath) ? path.relative(PROJECT_ROOT, assignmentPdfPath) : null,
    };
    next();
}

export function requireSubmissionToken(req, res, next) {
    const subToken = String(req.params.submissionToken || "").toLowerCase();
    if (!TOKEN_RE.test(subToken)) return res.status(404).json({ error: "submission not found" });
    if (!fs.existsSync(WORKS_ROOT)) return res.status(404).json({ error: "submission not found" });

    for (const we of fs.readdirSync(WORKS_ROOT, { withFileTypes: true })) {
        if (!we.isDirectory()) continue;
        const wParsed = parseDirName(we.name);
        if (!wParsed) continue;
        const workFullPath = path.join(WORKS_ROOT, we.name);
        const subFound = findSubmissionDirInWork(workFullPath, subToken);
        if (!subFound) continue;

        const assignmentPdfPath = path.join(workFullPath, "enunciado.pdf");
        req.work = {
            work_token: wParsed.token,
            name: wParsed.label,
            dir_name: we.name,
            full_path: workFullPath,
            assignment_pdf: fs.existsSync(assignmentPdfPath) ? path.relative(PROJECT_ROOT, assignmentPdfPath) : null,
        };

        const status = submissionStatus(subFound.fullPath);
        let finalReport = null;
        const reportPath = path.join(subFound.fullPath, "final_report.json");
        if (status === "finalized" && fs.existsSync(reportPath)) {
            try { finalReport = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch { /* ignore */ }
        }
        req.submission = {
            submission_token: subToken,
            student_label: subFound.label,
            status,
            final_report: finalReport,
            dir_name: subFound.dirName,
            full_path: subFound.fullPath,
        };
        return next();
    }
    return res.status(404).json({ error: "submission not found" });
}

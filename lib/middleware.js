import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { isWorkBudgetExceeded } from "./billing.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(LIB_DIR, "..");

// Token = 6 random bytes as lowercase hex (12 chars).
export function newToken() {
    return crypto.randomBytes(6).toString("hex");
}

const TOKEN_RE = /^[0-9a-f]{12}$/i;
const FORBIDDEN_LABEL_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

export function sanitizeLabel(raw) {
    const label = String(raw ?? "").trim();
    if (!label) throw new Error("label required");
    if (label.length > 80) throw new Error("label too long (max 80 chars)");
    if (FORBIDDEN_LABEL_CHARS.test(label)) throw new Error('label contains forbidden characters (< > : " / \\ | ? *)');
    if (label.endsWith(".") || label.endsWith(" ")) throw new Error("label cannot end with '.' or space");
    return label;
}

export function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: "unauthorized" });
    next();
}

export async function requireWorkToken(req, res, next) {
    const workToken = String(req.params.workToken || "").toLowerCase();
    if (!TOKEN_RE.test(workToken)) return res.status(404).json({ error: "work not found" });
    try {
        const work = await db.getWorkByToken(workToken);
        if (!work) return res.status(404).json({ error: "work not found" });
        req.work = {
            id: work.id,
            work_token: work.work_token,
            name: work.name,
            assignment_pdf: !!work.has_enunciado,
            has_interviewer: !!work.has_interviewer,
            interaction_mode: work.interaction_mode || "text",
            voice: work.voice || null,
            budget_usd: Number(work.budget_usd ?? 0),
            spent_usd: Number(work.spent_usd ?? 0),
        };
        next();
    } catch (err) {
        console.error("requireWorkToken db error:", err);
        return res.status(500).json({ error: "internal error" });
    }
}

// Bloqueia operações que vão incorrer custo no modelo quando o orçamento do
// trabalho já foi esgotado. Deve rodar DEPOIS de requireWorkToken /
// requireSubmissionToken (ambos populam req.work.id). Operações sem custo
// (GETs, listas, downloads) não precisam disso.
export async function requireWithinBudget(req, res, next) {
    try {
        if (!req.work?.id) return res.status(500).json({ error: "budget check without work context" });
        if (await isWorkBudgetExceeded(req.work.id)) {
            return res.status(402).json({
                error: "budget_exhausted",
                detail: "O orçamento deste trabalho foi esgotado. Procure o professor responsável.",
            });
        }
        next();
    } catch (err) {
        console.error("requireWithinBudget error:", err);
        return res.status(500).json({ error: "internal error" });
    }
}

export async function requireSubmissionToken(req, res, next) {
    const subToken = String(req.params.submissionToken || "").toLowerCase();
    if (!TOKEN_RE.test(subToken)) return res.status(404).json({ error: "submission not found" });
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found) return res.status(404).json({ error: "submission not found" });
        req.work = {
            id: found.work_id,
            work_token: found.work_token,
            name: found.work_name,
            assignment_pdf: !!found.work_enunciado_present,
            has_interviewer: !!found.work_interviewer_present,
            interaction_mode: found.work_interaction_mode || "text",
            voice: found.work_voice || null,
            budget_usd: Number(found.work_budget_usd ?? 0),
            spent_usd: Number(found.work_spent_usd ?? 0),
        };
        req.submission = {
            id: found.id,
            submission_token: found.submission_token,
            student_label: found.student_label,
            status: found.status,
        };
        return next();
    } catch (err) {
        console.error("requireSubmissionToken db error:", err);
        return res.status(500).json({ error: "internal error" });
    }
}

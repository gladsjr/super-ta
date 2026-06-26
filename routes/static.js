// Páginas HTML estáticas. Cada rota serve um arquivo de static/.

import path from "path";
import express from "express";
import * as db from "../lib/db.js";
import { PROJECT_ROOT } from "../lib/config.js";
import {
    CONSENT_VERSION,
    CONSENT_TEXT_HTML,
    CONSENT_AUDIO_ADDITION_HTML,
} from "../config/consent.js";

const router = express.Router();
const STATIC_DIR = path.join(PROJECT_ROOT, "static");

router.get("/", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
router.get("/admin", (_req, res) => res.sendFile(path.join(STATIC_DIR, "admin.html")));
router.get("/trabalho", (_req, res) => res.sendFile(path.join(STATIC_DIR, "trabalho.html")));
router.get("/envio", (_req, res) => res.sendFile(path.join(STATIC_DIR, "envio.html")));
router.get("/w/:workToken", (_req, res) => res.sendFile(path.join(STATIC_DIR, "professor.html")));
// Página do professor para PROVA ORAL (Realtime). O admin abre /w/:token/oral.
router.get("/w/:workToken/oral", (_req, res) => res.sendFile(path.join(STATIC_DIR, "oral-professor.html")));
router.get("/w/:workToken/s/:subToken", (_req, res) => res.sendFile(path.join(STATIC_DIR, "conversation.html")));
// Entrada do aluno: a MESMA URL serve a página certa pelo tipo do trabalho —
// prova oral (Realtime) → oral-student.html; senão → student.html (entrevista).
router.get("/s/:submissionToken", async (req, res) => {
    try {
        const found = await db.findSubmissionByToken(String(req.params.submissionToken || "").toLowerCase());
        if (found && found.work_kind === "oral_realtime") {
            return res.sendFile(path.join(STATIC_DIR, "oral-student.html"));
        }
    } catch { /* qualquer erro → cai no padrão (entrevista) */ }
    res.sendFile(path.join(STATIC_DIR, "student.html"));
});

// Termo de consentimento (texto + versão). Servido como JSON para o
// frontend renderizar dentro do modal antes do upload. Sem estado por aluno
// aqui — quem registra o aceite é o endpoint /s/:t/consent (Pacote B).
router.get("/api/consent", (_req, res) => {
    res.json({
        version: CONSENT_VERSION,
        textHtml: CONSENT_TEXT_HTML,
        audioAdditionHtml: CONSENT_AUDIO_ADDITION_HTML,
    });
});

export default router;

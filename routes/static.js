// Páginas HTML estáticas. Cada rota serve um arquivo de static/.

import path from "path";
import express from "express";
import { PROJECT_ROOT } from "../lib/config.js";

const router = express.Router();
const STATIC_DIR = path.join(PROJECT_ROOT, "static");

router.get("/", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
router.get("/admin", (_req, res) => res.sendFile(path.join(STATIC_DIR, "admin.html")));
router.get("/trabalho", (_req, res) => res.sendFile(path.join(STATIC_DIR, "trabalho.html")));
router.get("/envio", (_req, res) => res.sendFile(path.join(STATIC_DIR, "envio.html")));
router.get("/w/:workToken", (_req, res) => res.sendFile(path.join(STATIC_DIR, "professor.html")));
router.get("/w/:workToken/s/:subToken", (_req, res) => res.sendFile(path.join(STATIC_DIR, "conversation.html")));
router.get("/s/:submissionToken", (_req, res) => res.sendFile(path.join(STATIC_DIR, "student.html")));

export default router;

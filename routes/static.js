// Páginas HTML estáticas. Cada rota serve um arquivo de static/.

import path from "path";
import express from "express";
import * as db from "../lib/db.js";
import { PROJECT_ROOT } from "../lib/config.js";
import * as scenarioStore from "../lib/scenarios/store.js";
import {
    CONSENT_VERSION,
    CONSENT_TEXT_HTML,
    CONSENT_AUDIO_ADDITION_HTML,
    CONSENT_VIDEO_ADDITION_HTML,
    CONSENT_ORAL_HTML,
    CONSENT_LIVE_HTML,
} from "../config/consent.js";

const router = express.Router();
const STATIC_DIR = path.join(PROJECT_ROOT, "static");

// REVALIDAÇÃO obrigatória das páginas (#313, reaberto): sem Cache-Control, o
// cache heurístico do navegador pode servir HTML VELHO após um deploy — e o
// HTML velho carrega comportamento velho (foi assim que o gate antigo do
// sound check reapareceu já corrigido no servidor). ETag/304 mantém barato.
const page = (res, name) => res.sendFile(path.join(STATIC_DIR, name), { headers: { "Cache-Control": "no-cache" } });

router.get("/", (_req, res) => page(res, "index.html"));
router.get("/admin", (_req, res) => page(res, "admin.html"));
// Login ÚNICO (04/08/2026): /admin e /unidades mandam deslogados para cá; após
// entrar, roteia por papel (equipe → /admin; demais → /unidades). O POST /login
// (API) continua em server.js.
router.get("/login", (_req, res) => page(res, "login.html"));
router.get("/benchmark", (_req, res) => page(res, "benchmark.html"));
router.get("/cost-audit", (_req, res) => page(res, "cost-audit.html"));
// Camada institucional: unidades, papéis, tetos e pacotes (docs/access-model.md).
// /unidades é o nome oficial (04/08/2026); /instituicoes fica como alias.
router.get("/unidades", (_req, res) => page(res, "instituicoes.html"));
router.get("/instituicoes", (_req, res) => page(res, "instituicoes.html"));
router.get("/trabalho", (_req, res) => page(res, "trabalho.html"));
router.get("/envio", (_req, res) => page(res, "envio.html"));
// Página do professor. Resolve por TIPO no servidor (espelha a rota do aluno em
// /s/:submissionToken): prova oral (oral_realtime) → redireciona para /w/:token/oral.
// Assim link copiado, favorito e telas futuras acertam a tela sem depender de cada
// UI montar a URL certa (#172). Entrevista (mensagem/realtime) e cenário → professor.html.
router.get("/w/:workToken", async (req, res) => {
    const workToken = String(req.params.workToken || "").toLowerCase();
    try {
        const work = await db.getWorkByToken(workToken);
        if (work && work.kind === "oral_realtime") {
            return res.redirect(302, `/w/${workToken}/oral`);
        }
    } catch { /* na dúvida → tela de entrevista padrão */ }
    page(res, "professor.html");
});
// Estúdio de cenários escopado a um trabalho multi-interação (a página lê o
// token da URL e usa as rotas /w/:token/scenario). Mesma página do estúdio global.
router.get("/w/:workToken/studio", (_req, res) => page(res, "scenarios.html"));
// Página do professor para PROVA ORAL (Realtime). O admin abre /w/:token/oral.
router.get("/w/:workToken/oral", (_req, res) => page(res, "oral-professor.html"));
// Detalhe por aluno da PROVA ORAL (transcrição, avaliação, devolutiva, nota, vídeo).
router.get("/w/:workToken/oral/s/:subToken", (_req, res) => page(res, "oral-conversation.html"));
router.get("/w/:workToken/s/:subToken", (_req, res) => page(res, "conversation.html"));
// Entrada do aluno: a MESMA URL serve a página certa pelo tipo do trabalho —
// prova oral (Realtime) → oral-student.html; entrevista SIMPLIFICADA (tempo
// real) → live-student.html; cenário → scenario-student.html; senão →
// student.html (entrevista profunda). Decisão no servidor — sem flash.
router.get("/s/:submissionToken", async (req, res) => {
    try {
        const found = await db.findSubmissionByToken(String(req.params.submissionToken || "").toLowerCase());
        if (found && found.work_kind === "oral_realtime") return page(res, "oral-student.html");
        if (found && found.work_kind === "interview" && found.work_interview_variant === "realtime") {
            return page(res, "live-student.html");
        }
        if (found && await scenarioStore.getScenarioByWork(found.work_id)) return page(res, "scenario-student.html");
    } catch { /* na dúvida → entrevista padrão */ }
    page(res, "student.html");
});
router.get("/s/:submissionToken/scenario", (_req, res) => page(res, "scenario-student.html"));
router.get("/scenarios", (_req, res) => page(res, "scenarios.html"));

// Termo de consentimento (texto + versão). Servido como JSON para o
// frontend renderizar dentro do modal antes do upload. Sem estado por aluno
// aqui — quem registra o aceite é o endpoint /s/:t/consent (Pacote B).
router.get("/api/consent", (_req, res) => {
    res.json({
        version: CONSENT_VERSION,
        textHtml: CONSENT_TEXT_HTML,
        audioAdditionHtml: CONSENT_AUDIO_ADDITION_HTML,
        videoAdditionHtml: CONSENT_VIDEO_ADDITION_HTML,
        oralHtml: CONSENT_ORAL_HTML,
        liveHtml: CONSENT_LIVE_HTML,
    });
});

export default router;

// Bootstrap do servidor: middlewares globais, montagem dos routers, e o
// app.listen() que roda os seeds antes de aceitar tráfego.
//
// Migrations NÃO rodam aqui (ver "Schema do banco" no CLAUDE.md): em dev elas
// são aplicadas pelo `npm run db:migrate` (no workflow do Replit e no predev
// local); em produção o schema é gerido pelo fluxo de Publish do Replit.
//
// Toda lógica de rota vive em routes/*.js. Toda lógica de domínio vive em
// lib/*.js. Este arquivo é só o ponto de entrada.

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

import {
    sessionMiddleware,
    seedInitialUsers,
    seedInterviewerTemplates,
    loginHandler,
    logoutHandler,
    meHandler,
} from "./auth.js";
// O lib/config.js valida policy.yaml + pricing.yaml ao ser carregado.
// Importar PORT antes de tudo garante fail-fast no boot.
import { PORT, PRINCIPAL_REASONING_MODEL } from "./lib/config.js";
import staticRoutes from "./routes/static.js";
import adminRoutes from "./routes/admin.js";
import workRoutes from "./routes/work.js";
import interviewRoutes from "./routes/interview.js";
import scenarioRoutes from "./routes/scenarios.js";
import scenarioStudentRoutes from "./routes/scenarioStudent.js";
import scenarioCockpitRoutes from "./routes/scenarioCockpit.js";
import oralExamRoutes from "./routes/oralExam.js";
import { attachOralRelay } from "./lib/oralRealtime.js";
import diagRoutes from "./routes/diag.js";
import { requireAdmin } from "./lib/middleware.js";
import { initAudioStore } from "./lib/audioStore.js";
import log from "./lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middlewares globais.
app.use("/static", express.static(path.join(__dirname, "static")));
app.use(express.json({ limit: "2mb" }));
app.use(sessionMiddleware);

// Auth (público).
app.post("/login", loginHandler);
app.post("/logout", logoutHandler);
app.get("/me", meHandler);

// Routers por audiência. Cada arquivo declara seus paths completos —
// montamos sem prefixo para preservar exatamente as URLs anteriores.
app.use(staticRoutes);
app.use(adminRoutes);
app.use(scenarioCockpitRoutes); // /w/:t/scenario-runs|scenario-evaluations/* — cockpit do professor p/ cenários (requireAdmin por rota). Antes de workRoutes (paths específicos).
app.use(workRoutes);
app.use(interviewRoutes);
app.use("/scenarios/api", requireAdmin); // gate de sessão SÓ na API de config do professor (path-scoped; não afeta o fluxo do aluno nem a página pública /scenarios).
app.use(scenarioRoutes); // /scenarios/api/* (gateado acima). O dev server scenarios-dev.mjs monta sem gate (local).
app.use(scenarioStudentRoutes); // /s/:submissionToken/scenario/* — fluxo do aluno (auth por token de submissão).
app.use(oralExamRoutes); // /w/:t/oral/* e /s/:t/oral/* — prova oral (Realtime)
app.use(diagRoutes); // /diag/audio — diagnóstico do gate (dev; AUDIO_DIAG=1 em prod)

const httpServer = app.listen(PORT, "0.0.0.0", async () => {
    if (!process.env.OPENAI_API_KEY) {
        log.warn("BOOT", "OPENAI_API_KEY ausente no .env");
    }
    try {
        await seedInitialUsers();
    } catch (err) {
        log.error("BOOT", `seedInitialUsers failed: ${err.message}`);
    }
    try {
        await seedInterviewerTemplates();
    } catch (err) {
        log.error("BOOT", `seedInterviewerTemplates failed: ${err.message}`);
    }
    // Inicializa o store de áudio cedo pra que o backend ativo (e eventual
    // indisponibilidade) apareça no boot, não como no-op silencioso no meio
    // de uma entrevista. Não fatal — gravação é best-effort.
    try {
        const audio = await initAudioStore();
        log.info("BOOT", `audio_store backend=${audio.backend} available=${audio.available}${audio.available ? "" : ` reason=${audio.reason}`}`);
    } catch (err) {
        log.error("BOOT", `initAudioStore failed: ${err.message}`);
    }
    log.info("BOOT", `server listening http://0.0.0.0:${PORT} log_level=${log.level} model=${PRINCIPAL_REASONING_MODEL}`);
});

// Relay WebSocket da prova oral (Realtime) — navegador ↔ servidor ↔ OpenAI.
attachOralRelay(httpServer);

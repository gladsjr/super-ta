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
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import {
    sessionMiddleware,
    seedInitialUsers,
    seedRoles,
    seedProctorReviewLevels,
    seedCivilIdTypes,
    seedUnitLabels,
    seedAuthProviders,
    seedBootstrapAdmin,
    seedInterviewerTemplates,
    seedPackageTemplates,
    loginHandler,
    logoutHandler,
    meHandler,
} from "./auth.js";
// O lib/config.js valida policy.yaml + pricing.yaml ao ser carregado.
// Importar PORT antes de tudo garante fail-fast no boot.
import { PORT, PRINCIPAL_REASONING_MODEL } from "./lib/config.js";
import { initProctorQueue } from "./lib/proctorQueue.js";
import { startJobRunner } from "./lib/jobRunner.js";
import staticRoutes from "./routes/static.js";
import adminRoutes from "./routes/admin.js";
import unitsRoutes from "./routes/units.js";
import activationRoutes from "./routes/activation.js";
import authFederatedRoutes from "./routes/authFederated.js";
import authMockRoutes from "./routes/authMock.js";
import tenantLoginRoutes from "./routes/tenantLogin.js";
import tenantsAdminRoutes from "./routes/tenantsAdmin.js";
import workRoutes from "./routes/work.js";
import interviewRoutes from "./routes/interview.js";
import scenarioRoutes from "./routes/scenarios.js";
import scenarioStudentRoutes from "./routes/scenarioStudent.js";
import scenarioCockpitRoutes from "./routes/scenarioCockpit.js";
import oralExamRoutes from "./routes/oralExam.js";
import interviewLiveRoutes from "./routes/interviewLive.js";
import { attachOralRelay } from "./lib/oralRealtime.js";
import { attachLiveInterviewRelay } from "./lib/liveInterview.js";
import diagRoutes from "./routes/diag.js";
import benchmarkRoutes from "./routes/benchmark.js";
import costAuditRoutes from "./routes/costAudit.js";
import analyticsRoutes from "./routes/analytics.js";
import { requireAdmin } from "./lib/middleware.js";
import { initAudioStore } from "./lib/audioStore.js";
import log from "./lib/logger.js";

// Rede de segurança do processo. A causa raiz das quedas por conexão do banco é
// tratada no pool (ver auth.js#pool.on('error')); estes handlers são defensivos,
// para que qualquer falha inesperada fique registrada em vez de sumir no reinício
// da VM. Em uncaughtException o processo fica em estado indefinido: registramos e
// saímos (fail-fast) para a VM reiniciar limpo.
process.on("unhandledRejection", (reason) => {
    log.error("PROCESS", `unhandledRejection: ${reason?.stack || reason?.message || reason}`);
});
process.on("uncaughtException", (err) => {
    log.error("PROCESS", `uncaughtException: ${err?.stack || err?.message || err}`);
    process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middlewares globais.
// helmet: headers de segurança (X-Frame-Options, X-Content-Type-Options nosniff,
// HSTS, etc.). CSP fica DESLIGADA de propósito — as telas carregam scripts de CDN
// (KaTeX/marked) e inline, e uma CSP restritiva quebraria o front. Ligar CSP com
// allowlist testada é um passo separado.
app.use(helmet({ contentSecurityPolicy: false }));
app.use("/static", express.static(path.join(__dirname, "static")));

// Parser JSON global, teto apertado (2mb) — vale para praticamente tudo.
// EXCEÇÃO: rotas que declaram o próprio teto por serem legitimamente grandes.
// Sem essa exclusão o parser global roda ANTES do router e estoura
// PayloadTooLargeError, tornando o limite da rota código morto.
const GLOBAL_JSON_SKIP = new Set(["/api/benchmark/import"]); // bundle de benchmark: express.json({limit:"200mb"}) em routes/benchmark.js
const globalJsonParser = express.json({ limit: "2mb" });
app.use((req, res, next) => {
    if (GLOBAL_JSON_SKIP.has(req.path)) return next();
    return globalJsonParser(req, res, next);
});
app.use(sessionMiddleware);

// Auth (público). Rate limit no /login para travar força bruta de senha de
// professor. Janela de 15 min; logins bem-sucedidos não contam (skipSuccessful),
// então uso legítimo não é penalizado.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Muitas tentativas de login. Tente de novo em alguns minutos." },
});
app.post("/login", loginLimiter, loginHandler);
app.post("/logout", logoutHandler);
app.get("/me", meHandler);
app.use(authFederatedRoutes); // /auth/google[/callback] — SSO opcional (501 se não configurado)

// Routers por audiência. Cada arquivo declara seus paths completos —
// montamos sem prefixo para preservar exatamente as URLs anteriores.
app.use(staticRoutes);
app.use(adminRoutes);
app.use(unitsRoutes); // /admin/units/* — camada institucional (sessão + RBAC por unidade)
app.use(activationRoutes); // /ativar + /api/ativar — ativação de conta por convite (público, token de uso único)
app.use(authMockRoutes); // /auth/mock/* — IdP de mentira (só dev; Fase 2 do multi-tenant)
app.use(tenantLoginRoutes); // /api/tenant/:slug + /api/hint — config da porta do tenant + pista de domínio
app.use(tenantsAdminRoutes); // /admin/units/:id/tenant|domains|providers|accepted-providers — config de tenant (admin global)
app.use(scenarioCockpitRoutes); // /w/:t/scenario-runs|scenario-evaluations/* — cockpit do professor p/ cenários (requireAdmin por rota). Antes de workRoutes (paths específicos).
app.use(workRoutes);
app.use(interviewRoutes);
app.use("/scenarios/api", requireAdmin); // gate de sessão SÓ na API de config do professor (path-scoped; não afeta o fluxo do aluno nem a página pública /scenarios).
app.use(scenarioRoutes); // /scenarios/api/* (gateado acima). O dev server scenarios-dev.mjs monta sem gate (local).
app.use(scenarioStudentRoutes); // /s/:submissionToken/scenario/* — fluxo do aluno (auth por token de submissão).
app.use(oralExamRoutes); // /w/:t/oral/* e /s/:t/oral/* — prova oral (Realtime)
app.use(interviewLiveRoutes); // /s/:t/live/* — entrevista SIMPLIFICADA (tempo real, por voz)
app.use(diagRoutes); // /diag/audio — diagnóstico do gate (dev; AUDIO_DIAG=1 em prod)
app.use(benchmarkRoutes); // /api/benchmark/* — benchmark interno (requireAdmin por rota)
app.use(costAuditRoutes); // /api/cost-audit/* — auditoria de custo (Usage/Costs API; requireAdmin por rota)
app.use(analyticsRoutes); // /api/analytics/query — consulta somente-leitura p/ benchmark (auth por API key; NÃO sessão; ver migration 052)

// PORTA DA INSTITUIÇÃO — rota CURINGA por slug (Fase 4). Fica por ÚLTIMO: só
// captura caminhos de 1 segmento que nenhuma rota anterior atendeu. Serve a
// página se o slug for um tenant existente; senão, 404. Slugs são controlados
// pela equipe (não há auto-cadastro), então não sombreiam rotas reais.
app.get("/:slug", async (req, res, next) => {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return next();
    try {
        const { getTenantBySlug } = await import("./lib/tenants.js");
        if (!(await getTenantBySlug(slug))) return next();
        return res.sendFile(path.join(__dirname, "static", "tenant-login.html"));
    } catch (err) {
        log.error("TENANT", `slug route failed: ${err.message}`);
        return next();
    }
});

const httpServer = app.listen(PORT, "0.0.0.0", async () => {
    if (!process.env.OPENAI_API_KEY) {
        log.warn("BOOT", "OPENAI_API_KEY ausente no .env");
    }
    try {
        await seedInitialUsers();
    } catch (err) {
        log.error("BOOT", `seedInitialUsers failed: ${err.message}`);
    }
    // seedRoles/seedAuthProviders antes do bootstrap admin (que precisa da
    // linha 'admin_global' na tabela roles).
    try {
        await seedRoles();
    } catch (err) {
        log.error("BOOT", `seedRoles failed: ${err.message}`);
    }
    try {
        await seedProctorReviewLevels();
    } catch (err) {
        log.error("BOOT", `seedProctorReviewLevels failed: ${err.message}`);
    }
    try {
        await seedCivilIdTypes();
    } catch (err) {
        log.error("BOOT", `seedCivilIdTypes failed: ${err.message}`);
    }
    try {
        await seedUnitLabels();
    } catch (err) {
        log.error("BOOT", `seedUnitLabels failed: ${err.message}`);
    }
    try {
        await seedAuthProviders();
    } catch (err) {
        log.error("BOOT", `seedAuthProviders failed: ${err.message}`);
    }
    try {
        await seedBootstrapAdmin();
    } catch (err) {
        log.error("BOOT", `seedBootstrapAdmin failed: ${err.message}`);
    }
    try {
        await seedInterviewerTemplates();
    } catch (err) {
        log.error("BOOT", `seedInterviewerTemplates failed: ${err.message}`);
    }
    try {
        await seedPackageTemplates();
    } catch (err) {
        log.error("BOOT", `seedPackageTemplates failed: ${err.message}`);
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
    // Fila global de proctoring (#262): carrega a concorrência persistida e
    // RECONCILIA — 'queued'/'running' órfãos de reinício e legado com vídeo sem
    // relatório voltam para a fila (substitui o antigo "órfã vira failed" do #220:
    // agora a análise interrompida é retomada, não descartada).
    try {
        await initProctorQueue();
    } catch (err) {
        log.error("BOOT", `initProctorQueue failed: ${err.message}`);
    }
    // Executor da fila de jobs (#289, corte 3): retranscrição na janela ociosa.
    // Também recupera jobs órfãos de reinício (lease vencida volta a elegível).
    startJobRunner();
    log.info("BOOT", `server listening http://0.0.0.0:${PORT} log_level=${log.level} model=${PRINCIPAL_REASONING_MODEL}`);
});

// Relay WebSocket da prova oral (Realtime) — navegador ↔ servidor ↔ OpenAI.
attachOralRelay(httpServer);
attachLiveInterviewRelay(httpServer);

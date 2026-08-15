// Rotas do ALUNO da ENTREVISTA SIMPLIFICADA (tempo real, por voz) — trabalho
// kind='interview' com works.interview_variant='realtime'. Página do aluno:
// static/live-student.html (código próprio, separado de student.html e
// oral-student.html). Fluxo: consentimento → upload do PDF (dispara a MESMA
// preparação da entrevista por mensagens: PrepBuilderAgent → análise + plano de
// perguntas, persistidos em submissions.live_prep_json) → teste de
// conexão/ruído/calibração → posicionamento → sessão de voz (relay em
// lib/liveInterview.js) → revisão/comentário/resultado (REUSAM as rotas da
// entrevista: GET /s/:t/review, POST /s/:t/comment, GET /s/:t/evaluation).
//
// Auth do aluno: requireSubmissionToken (token da submissão é a credencial).

import express from "express";
import multer from "multer";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import { requireSubmissionToken, requireNotFinalized, requireWithinBudget } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { runProctorAuto } from "../lib/proctorAuto.js";
import { clientForWork } from "../lib/openaiClient.js";
import { prepBuilderAgent } from "../lib/agents.js";
import { putAudio, extFromMimetype } from "../lib/audioStore.js";
import { transcribeAudio } from "../lib/audio.js";
import { scoreCalibration } from "../lib/speechCalib.js";
import { STT_MODEL } from "../lib/config.js";
import { CONSENT_VERSION } from "../config/consent.js";
import log from "../lib/logger.js";

const router = express.Router();

const PDF_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MB — igual à entrevista
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PDF_UPLOAD_LIMIT_BYTES } });
// Vídeo (até 300MB): em DISCO, não memória — mesma decisão da prova oral
// (uploads simultâneos de vídeo não podem segurar RAM).
const videoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });
// Clipe curto do pré-teste de calibração de fala (em memória; poucos segundos).
const calibUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const MAX_CALIB_ATTEMPTS = 2;

// Garante que o trabalho é uma entrevista SIMPLIFICADA antes de seguir.
function requireLive(req, res, next) {
    if (req.work.kind !== "interview" || req.work.interview_variant !== "realtime") {
        return res.status(400).json({ error: "este trabalho não é uma entrevista em tempo real" });
    }
    next();
}

// Preparações EM VOO (por submission id): a prep roda em background após o
// upload (30–90s de análise + plano); a página faz polling em /live/prep-status.
// Em memória basta — se o servidor reiniciar no meio, o aluno reenvia o PDF.
const PREPARING = new Map(); // submissionId → { startedAt } | { error }

// Status para a página do aluno decidir a tela inicial.
router.get("/s/:submissionToken/live/status", requireSubmissionToken, requireLive, async (req, res) => {
    try {
        const prep = await db.getLivePrep(req.submission.id);
        const inFlight = PREPARING.get(req.submission.id);
        let prepStatus = "none";
        if (prep?.plan?.questions?.length) prepStatus = "ready";
        else if (inFlight && !inFlight.error) prepStatus = "preparing";
        else if (inFlight?.error) prepStatus = "error";
        res.set("Cache-Control", "no-store");
        res.json({
            work_name: req.work.name,
            student_label: req.submission.student_label || null,
            done: !!req.submission.completion_reason && !req.submission.is_test,
            is_test: !!req.submission.is_test,
            consented: !!req.submission.consent_version,
            prep_status: prepStatus,
            question_count: prep?.plan?.questions?.length ?? null,
        });
    } catch (err) {
        log.error("LIVE", `status failed: ${err.message}`);
        res.status(500).json({ error: "falha" });
    }
});

// Registra o aceite do consentimento (voz + vídeo + PDF) ANTES do upload.
// Verificado no servidor: o upload e o relay recusam sem aceite registrado.
router.post("/s/:submissionToken/live/consent", requireSubmissionToken, requireLive, async (req, res) => {
    try {
        await db.setSubmissionConsentVersion(req.submission.id, CONSENT_VERSION);
        log.info("LIVE", `consent registrado submission=${req.submission.submission_token} v=${CONSENT_VERSION}`);
        res.json({ ok: true, version: CONSENT_VERSION });
    } catch (err) {
        log.error("LIVE", `consent failed: ${err.message}`);
        res.status(500).json({ error: "falha ao registrar consentimento" });
    }
});

// Upload do trabalho do aluno → dispara a preparação (a MESMA da entrevista por
// mensagens: PrepBuilderAgent lê os dois PDFs e a agenda do entrevistador e
// produz análise + plano de perguntas). Responde 202 imediatamente; a página
// acompanha por /live/prep-status.
router.post("/s/:submissionToken/live/upload", requireSubmissionToken, requireLive, requireNotFinalized, requireWithinBudget, pdfUpload.single("file"), async (req, res) => {
    const token = req.submission.submission_token;
    try {
        if (!req.submission.consent_version) {
            return res.status(403).json({ error: "consent_required", detail: "Aceite o termo de consentimento antes de enviar o trabalho." });
        }
        if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: "file required (PDF)" });
        if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "apenas PDF é aceito" });
        if (PREPARING.get(req.submission.id) && !PREPARING.get(req.submission.id).error) {
            return res.status(409).json({ error: "preparation_in_progress", detail: "A preparação já está em andamento." });
        }
        // Entrevista já começada (aluno REAL com falas registradas) → não aceita
        // reenvio: o caminho é RETOMAR a conversa (o relay retoma sozinho).
        if (!req.submission.is_test) {
            const transcript = await db.getOralTranscript(req.submission.id).catch(() => []);
            if (Array.isArray(transcript) && transcript.some(t => t.role === "student")) {
                return res.status(409).json({ error: "interview_started", detail: "A entrevista já começou — recarregue a página para retomar de onde parou." });
            }
        }
        // Insumos do trabalho: falha EXPLÍCITA se faltar (mesma regra do /upload
        // da entrevista — sem fallback arquitetural).
        const [interviewerYamlText, enunciadoBlob] = await Promise.all([
            db.getInterviewerYaml(req.work.id),
            db.getEnunciadoBlob(req.work.id),
        ]);
        if (!interviewerYamlText) return res.status(400).json({ error: "entrevistador não configurado neste trabalho" });
        if (!enunciadoBlob) return res.status(400).json({ error: "enunciado ausente neste trabalho" });

        const studentBuffer = req.file.buffer;
        const studentFilename = req.file.originalname || "trabalho.pdf";
        const submissionId = req.submission.id;
        const questionCount = req.work.question_count;
        const meterCtx = { workId: req.work.id };
        const cli = clientForWork(req.work);

        // REENVIO substitui a preparação anterior: limpa o plano persistido ANTES
        // de disparar a nova prep — senão o /live/prep-status (que lê o banco
        // primeiro) responderia "ready" com o plano VELHO durante a regeneração,
        // e o relay poderia começar com ele.
        await db.setLivePrep(submissionId, null);
        PREPARING.set(submissionId, { startedAt: Date.now() });
        // Preparação em BACKGROUND (o aluno segue para o teste de conexão e
        // posicionamento enquanto ela roda — a janela dessas telas costuma
        // cobrir a latência da prep, como o intro cobre na entrevista).
        (async () => {
            try {
                log.info("LIVE_PREP", `start submission=${token} file="${studentFilename}" bytes=${studentBuffer.length}`);
                const [, studentFile, enunciadoFile] = await Promise.all([
                    db.setStudentPdf(submissionId, studentBuffer, studentFilename),
                    cli.files.create({ file: await OpenAI.toFile(studentBuffer, studentFilename), purpose: "user_data" }),
                    cli.files.create({ file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"), purpose: "user_data" }),
                ]);
                const prep = await prepBuilderAgent.buildPrep({
                    studentFileId: studentFile.id,
                    enunciadoFileId: enunciadoFile.id,
                    interviewerYamlText,
                    questionCount,
                    meterCtx,
                });
                await db.setLivePrep(submissionId, {
                    analysis: prep.analysis,
                    plan: prep.plan,
                    prepared_at: new Date().toISOString(),
                    student_filename: studentFilename,
                });
                PREPARING.delete(submissionId);
                log.info("LIVE_PREP", `done submission=${token} questions=${prep.plan?.questions?.length}`);
            } catch (err) {
                log.error("LIVE_PREP", `failed submission=${token}: ${err.message}`);
                PREPARING.set(submissionId, { error: err.message });
            }
        })();

        res.status(202).json({ ok: true, preparing: true });
    } catch (err) {
        log.error("LIVE", `upload failed submission=${token}: ${err.message}`);
        res.status(500).json({ error: "falha no envio do trabalho", detail: err.message });
    }
});

// Polling da preparação. 'ready' quando o plano está persistido.
router.get("/s/:submissionToken/live/prep-status", requireSubmissionToken, requireLive, async (req, res) => {
    try {
        const prep = await db.getLivePrep(req.submission.id);
        res.set("Cache-Control", "no-store");
        if (prep?.plan?.questions?.length) {
            return res.json({ status: "ready", question_count: prep.plan.questions.length });
        }
        const inFlight = PREPARING.get(req.submission.id);
        if (inFlight?.error) return res.json({ status: "error", detail: inFlight.error });
        if (inFlight) return res.json({ status: "preparing" });
        res.json({ status: "none" });
    } catch (err) {
        log.error("LIVE", `prep-status failed: ${err.message}`);
        res.status(500).json({ error: "falha" });
    }
});

// --- Calibração de fala (pré-teste de captação) — espelha a prova oral, que já
// compartilha a coluna works.oral_calibration_json com a entrevista. ---
router.get("/s/:submissionToken/live/calibrate-config", requireSubmissionToken, requireLive, async (req, res) => {
    try {
        const calib = await db.getOralCalibration(req.work.id);
        res.set("Cache-Control", "no-store");
        res.json({ enabled: !!calib, sentence: calib?.sentence || null, max_attempts: MAX_CALIB_ATTEMPTS });
    } catch (err) { log.error("LIVE", `calibrate-config failed: ${err.message}`); res.status(500).json({ error: "falha" }); }
});

const CALIB_ADVICE = "Fale em volume médio, num ritmo tranquilo (sem correr) e sem cortar o fim das palavras — assim a captação transcreve melhor a sua fala.";
router.post("/s/:submissionToken/live/calibrate", requireSubmissionToken, requireLive, calibUpload.single("file"), async (req, res) => {
    try {
        const calib = await db.getOralCalibration(req.work.id);
        if (!calib) return res.status(409).json({ error: "sem frase de calibração" });
        if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: "file required" });
        let attempt = Number(req.body?.attempt);
        if (!Number.isInteger(attempt) || attempt < 1) attempt = 1;
        if (attempt > MAX_CALIB_ATTEMPTS) attempt = MAX_CALIB_ATTEMPTS;

        // Extensão pelo mimetype real: MediaRecorder varia por navegador (webm no
        // Chrome/Firefox, mp4/m4a no Safari) e o STT infere o formato pela extensão.
        const { text } = await transcribeAudio(clientForWork(req.work), STT_MODEL, req.file.buffer, `calib.${extFromMimetype(req.file.mimetype)}`);
        const { ok, wer, missedTerms } = scoreCalibration({ target: calib.sentence, keyTerms: calib.key_terms || [], hypothesis: text });

        // Acumula o registro (todas as tentativas) para o professor.
        const prev = (await db.getOralSubmissionDetail(req.submission.id))?.oral_calibration_json || null;
        const transcripts = (Array.isArray(prev?.transcripts) ? prev.transcripts : []).slice(-3);
        transcripts.push({ attempt, wer: wer == null ? null : Math.round(wer * 1000) / 1000, missed: missedTerms, text });
        const worst = Math.max(Number(prev?.worst_wer) || 0, wer == null ? 0 : wer);
        await db.setOralCalibrationResult(req.submission.id, {
            passed: ok || prev?.passed === true,
            attempts: attempt,
            worst_wer: Math.round(worst * 1000) / 1000,
            missed_terms: missedTerms,
            target: calib.sentence,
            transcripts,
            updated_at: new Date().toISOString(),
        });

        log.info("LIVE", `calibrate submission=${req.submission.submission_token} attempt=${attempt} ok=${ok} wer=${wer == null ? "—" : wer.toFixed(2)} missed=${missedTerms.length}`);
        res.json({
            ok, attempt, attempts_left: Math.max(0, MAX_CALIB_ATTEMPTS - attempt),
            wer, missed_terms: missedTerms, transcript: text, advice: ok ? null : CALIB_ADVICE,
        });
    } catch (err) {
        log.error("LIVE", `calibrate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao verificar a captação", detail: err.message });
    }
});

// Recebe o vídeo gravado da entrevista e guarda no object storage (não vai à
// OpenAI). Multi-parte: original + cada retomada, chave única por segmento.
// Reusa as colunas oral_video_parts/oral_proctor_json — o painel e a análise de
// proctoring do professor (routes/work.js) já operam sobre elas.
router.post("/s/:submissionToken/live/video", requireSubmissionToken, videoUpload.single("file"), async (req, res) => {
    try {
        if (req.work.kind !== "interview" || req.work.interview_variant !== "realtime") {
            return res.status(400).json({ error: "este trabalho não é uma entrevista em tempo real" });
        }
        if (!req.file) return res.status(400).json({ error: "file required" });
        const ext = extFromMimetype(req.file.mimetype);
        const key = `live-video/${req.submission.submission_token}-${Date.now()}.${ext}`;
        const buffer = await fs.promises.readFile(req.file.path); // do temporário em disco
        const r = await putAudio({ key, buffer, mimetype: req.file.mimetype });
        if (!r.stored) {
            log.error("LIVE", `vídeo não armazenado submission=${req.submission.submission_token}: ${r.reason}`);
            return res.status(502).json({ error: "falha ao armazenar o vídeo", detail: r.reason });
        }
        await db.appendOralVideoPart(req.submission.id, key);
        // Gate de vídeo obrigatório: promove a submissão que aguardava vídeo p/
        // concluir (o vídeo sobe após o encerramento da sessão de voz).
        const promoted = await db.promoteAwaitingVideo(req.submission.id);
        log.info("LIVE", `segmento de vídeo armazenado submission=${req.submission.submission_token} key=${key} bytes=${buffer.length}${promoted ? " (conclui: aguardava vídeo)" : ""}`);
        // Análise de vídeo AUTOMÁTICA (#210): dispara em background ao chegar o vídeo.
        runProctorAuto(req.submission.id, req.submission.submission_token);
        res.json({ ok: true });
    } catch (err) {
        log.error("LIVE", `video upload failed: ${err.message}`);
        res.status(500).json({ error: "falha no upload do vídeo", detail: err.message });
    } finally {
        if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    }
});

export default router;

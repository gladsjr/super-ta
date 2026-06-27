// Rotas da PROVA ORAL (Realtime). Tipo de trabalho `kind='oral_realtime'`.
// Lado do professor: subir o PDF de perguntas-e-respostas (extração via modelo
// rápido), ver as perguntas e configurar N + voz. Lado do aluno (minting da
// sessão Realtime) entra na Fase B, neste mesmo router.
//
// Auth do professor: requireWorkToken (o token do trabalho é a credencial,
// como no resto do painel do professor). Sem login.

import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { requireWorkToken, requireSubmissionToken, requireProfessorSubmission } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { openai } from "../lib/openaiClient.js";
import { oralExamExtractorAgent } from "../lib/agents.js";
import { putAudio, streamAudio, extFromMimetype } from "../lib/audioStore.js";
import { VOICES, isValidVoice } from "../config/voices.js";
import { isValidQuestionCount, REALTIME_MODEL } from "../lib/config.js";
import { CONSENT_VERSION } from "../config/consent.js";
import { sampleKeepingOrder, buildExamInstructions } from "../lib/oralRealtime.js";
import log from "../lib/logger.js";

const router = express.Router();
const examUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } }); // vídeo da prova (até 300MB)

// Garante que o trabalho é uma prova oral antes de seguir.
function requireOral(req, res, next) {
    if (req.work.kind !== "oral_realtime") {
        return res.status(400).json({ error: "este trabalho não é uma prova oral" });
    }
    next();
}

// Info para a página do professor: config + perguntas extraídas (o professor vê
// perguntas E respostas — é a prova dele) + lista de vozes.
router.get("/w/:workToken/oral/info", requireWorkToken, requireOral, async (req, res) => {
    try {
        const [questions, subs] = await Promise.all([
            db.getOralQuestions(req.work.id),
            db.listSubmissionsForWork(req.work.id),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            work: {
                name: req.work.name,
                kind: req.work.kind,
                has_exam: req.work.has_exam,
                question_count: req.work.question_count,
                voice: req.work.voice,
            },
            questions,
            submissions: (subs || []).map(s => ({ submission_token: s.submission_token, student_label: s.student_label, status: s.status, has_oral_video: !!s.has_oral_video, is_test: !!s.is_test })),
            voices: VOICES,
        });
    } catch (err) {
        log.error("ORAL", `info failed: ${err.message}`);
        res.status(500).json({ error: "falha ao carregar a prova" });
    }
});

// Upload do PDF da prova → extração das perguntas (modelo rápido).
router.post("/w/:workToken/oral/exam-pdf", requireWorkToken, requireOral, examUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    try {
        await db.setExamPdf(req.work.id, req.file.buffer, req.file.originalname);
        const examFile = await openai.files.create({
            file: await OpenAI.toFile(req.file.buffer, req.file.originalname || "prova.pdf"),
            purpose: "user_data",
        });
        const questions = await oralExamExtractorAgent.extract({
            examFileId: examFile.id,
            meterCtx: { workId: req.work.id },
        });
        await db.setOralQuestions(req.work.id, questions);
        log.info("ORAL", `exam uploaded+extracted work=${req.work.work_token} questions=${questions.length}`);
        res.json({ ok: true, count: questions.length, questions });
    } catch (err) {
        log.error("ORAL", `exam-pdf failed: ${err.message}`);
        res.status(500).json({ error: "falha ao processar a prova", detail: err.message });
    }
});

// Config da prova: número de perguntas (N) + voz do examinador.
router.post("/w/:workToken/oral/config", requireWorkToken, requireOral, async (req, res) => {
    const n = Number(req.body?.question_count);
    const voice = req.body?.voice;
    if (!isValidQuestionCount(n)) return res.status(400).json({ error: "question_count inválido (3 a 20)" });
    if (voice != null && voice !== "" && !isValidVoice(voice)) return res.status(400).json({ error: "voz inválida" });
    try {
        await db.setQuestionCount(req.work.id, n);
        if (voice) await db.setWorkVoice(req.work.id, voice);
        log.info("ORAL", `config work=${req.work.work_token} n=${n} voice=${voice || "-"}`);
        res.json({ ok: true, question_count: n, voice: voice || null });
    } catch (err) {
        log.error("ORAL", `config failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a configuração" });
    }
});

// Perguntas digitadas/editadas à mão (alternativa ou complemento ao PDF). O
// corpo é [{question, answer}]; re-indexamos e gravamos em oral_questions.
router.post("/w/:workToken/oral/questions", requireWorkToken, requireOral, async (req, res) => {
    const raw = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (!raw) return res.status(400).json({ error: "questions (array) required" });
    const cleaned = raw
        .map(q => ({ question: String(q?.question || "").trim(), answer: String(q?.answer || "").trim() }))
        .filter(q => q.question)
        .map((q, i) => ({ id: i + 1, ...q }));
    if (cleaned.length === 0) return res.status(400).json({ error: "nenhuma pergunta válida (cada pergunta precisa de enunciado)" });
    try {
        await db.setOralQuestions(req.work.id, cleaned);
        log.info("ORAL", `perguntas manuais salvas work=${req.work.work_token} n=${cleaned.length}`);
        res.json({ ok: true, count: cleaned.length, questions: cleaned });
    } catch (err) {
        log.error("ORAL", `save questions failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar as perguntas" });
    }
});

// --- Lado do ALUNO (Realtime) ---


// Cria um client secret EFÊMERO da OpenAI Realtime, com a sessão já configurada
// (modelo, voz, instruções com as perguntas, VAD de servidor, transcrição da
// fala do aluno). A nossa OPENAI_API_KEY nunca vai ao navegador — só o segredo
// efêmero de ~1 min. Usamos fetch cru para não acoplar à versão do SDK.
async function mintRealtimeSecret({ instructions, voice }) {
    const body = {
        session: {
            type: "realtime",
            model: REALTIME_MODEL,
            instructions,
            audio: {
                input: {
                    transcription: { model: "gpt-4o-transcribe" },
                    // VAD semântico, pressa MÉDIA: tolera pausas para pensar sem
                    // picotar a fala, mas sem demorar demais para perceber o fim.
                    // (low = paciente demais; high = corta cedo.)
                    turn_detection: { type: "semantic_vad", eagerness: "medium" },
                },
                output: { voice },
            },
        },
    };
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`realtime client_secret ${r.status}: ${text.slice(0, 400)}`);
    let j; try { j = JSON.parse(text); } catch { throw new Error("realtime client_secret: resposta não-JSON"); }
    // Defensivo quanto ao shape entre versões da API.
    const value = j.value || j.client_secret?.value || j.client_secret;
    if (!value) throw new Error("realtime client_secret: sem 'value' na resposta");
    return { value, expires_at: j.expires_at || j.client_secret?.expires_at || null };
}

// Inicia uma prova: sorteia N perguntas, monta a sessão e devolve o segredo
// efêmero para o navegador abrir o WebRTC direto com a OpenAI.
router.post("/s/:submissionToken/oral/session", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") {
        return res.status(400).json({ error: "este trabalho não é uma prova oral" });
    }
    try {
        const all = await db.getOralQuestions(req.work.id);
        if (!all.length) return res.status(409).json({ error: "a prova ainda não foi preparada pelo professor (sem perguntas)" });
        const n = Math.min(req.work.question_count || all.length, all.length);
        const sampled = sampleKeepingOrder(all, n);
        const voice = isValidVoice(req.work.voice) ? req.work.voice : "verse";
        const instructions = buildExamInstructions(sampled.map(q => q.question), req.work.name);
        const secret = await mintRealtimeSecret({ instructions, voice });
        log.info("ORAL", `session minted submission=${req.submission.submission_token} n=${n}/${all.length} voice=${voice}`);
        res.json({
            client_secret: secret.value,
            expires_at: secret.expires_at,
            model: REALTIME_MODEL,
            voice,
            total_questions: n,
        });
    } catch (err) {
        log.error("ORAL", `session failed: ${err.message}`);
        res.status(502).json({ error: "falha ao iniciar a sessão de voz", detail: err.message });
    }
});

// Registra o aceite do consentimento (voz + vídeo) ANTES de começar a prova.
router.post("/s/:submissionToken/oral/consent", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        await db.setSubmissionConsentVersion(req.submission.id, CONSENT_VERSION);
        log.info("ORAL", `consent registrado submission=${req.submission.submission_token} v=${CONSENT_VERSION}`);
        res.json({ ok: true, version: CONSENT_VERSION });
    } catch (err) {
        log.error("ORAL", `consent failed: ${err.message}`);
        res.status(500).json({ error: "falha ao registrar consentimento" });
    }
});

// Recebe o vídeo gravado da prova e guarda no object storage (não vai à OpenAI).
router.post("/s/:submissionToken/oral/video", requireSubmissionToken, videoUpload.single("file"), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    if (!req.file) return res.status(400).json({ error: "file required" });
    try {
        const ext = extFromMimetype(req.file.mimetype);
        const key = `oral-video/${req.submission.submission_token}.${ext}`;
        const r = await putAudio({ key, buffer: req.file.buffer, mimetype: req.file.mimetype });
        if (!r.stored) {
            log.error("ORAL", `vídeo não armazenado submission=${req.submission.submission_token}: ${r.reason}`);
            return res.status(502).json({ error: "falha ao armazenar o vídeo", detail: r.reason });
        }
        await db.setOralVideoKey(req.submission.id, key);
        log.info("ORAL", `vídeo armazenado submission=${req.submission.submission_token} key=${key} bytes=${req.file.buffer.length}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("ORAL", `video upload failed: ${err.message}`);
        res.status(500).json({ error: "falha no upload do vídeo", detail: err.message });
    }
});

// Professor assiste ao vídeo gravado (avaliação posterior). Auth por token do
// trabalho + submissão pertencente a ele.
router.get("/w/:workToken/oral/video/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    try {
        const key = await db.getOralVideoKey(req.submission.id);
        if (!key) return res.status(404).json({ error: "sem vídeo para esta submissão" });
        const stream = await streamAudio(key);
        if (!stream) return res.status(404).json({ error: "vídeo indisponível no armazenamento" });
        const ext = key.split(".").pop();
        res.set("Content-Type", ext === "mp4" || ext === "m4a" ? "video/mp4" : "video/webm");
        stream.on("error", () => { if (!res.headersSent) res.status(500).end(); });
        stream.pipe(res);
    } catch (err) {
        log.error("ORAL", `video serve failed: ${err.message}`);
        res.status(500).json({ error: "falha ao servir o vídeo" });
    }
});

export default router;

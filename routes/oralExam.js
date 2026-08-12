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
import fs from "fs";
import os from "os";
import { requireWorkToken, requireSubmissionToken, requireProfessorSubmission, requireWithinBudget } from "../lib/middleware.js";
import { publicBaseUrl } from "../lib/publicUrl.js";
import * as db from "../lib/db.js";
import { openai, clientForWork, apiKeyForWork } from "../lib/openaiClient.js";
import { oralExamExtractorAgent, oralExamEvaluatorAgent, oralRubricBuilderAgent, oralCalibrationAgent } from "../lib/agents.js";
import { putAudio, localFilePath, readAllBytes, extFromMimetype } from "../lib/audioStore.js";
import { transcribeAudio } from "../lib/audio.js";
import { scoreCalibration } from "../lib/speechCalib.js";
import { VOICES, isValidVoice } from "../config/voices.js";
import { isValidQuestionCount, REALTIME_MODEL, STT_MODEL } from "../lib/config.js";
import { CONSENT_VERSION } from "../config/consent.js";
import { sampleKeepingOrder, buildExamInstructions } from "../lib/oralRealtime.js";
import { analyzeOralVideo, analyzeOralVideoParts } from "../lib/proctor.js";
import { mapPool } from "../lib/concurrency.js";
import { weightedFinal } from "../lib/rubric.js";
import { deriveOralDevolutivaNow } from "../lib/oralFeedbackOps.js";
import { applyPenaltyToGrades } from "../lib/gradePenalty.js";
import { REVIEW_WINDOW_DAYS, reviewWindowState } from "../lib/reviewWindow.js";
import log from "../lib/logger.js";

const MAX_COMMENT_LEN = 2000;

const router = express.Router();
const examUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
// Vídeo da prova (até 300MB): em DISCO (não memória). Com memoryStorage, 50
// uploads simultâneos seguram até 300MB cada na RAM durante toda a transferência
// (lenta no mobile). Em disco, a transferência não pesa na RAM; só lemos o arquivo
// na hora de mandar pro storage, e apagamos o temporário em seguida.
const videoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });
// Clipe curto de áudio do pré-teste de calibração de fala (em memória; poucos segundos).
const calibUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
// Nº máximo de tentativas do pré-teste de calibração antes de o aluno seguir mesmo assim.
const MAX_CALIB_ATTEMPTS = 2;

// Alertas de proctoring por VÍDEO para a lista do professor (resumo conservador,
// calculado dos flags brutos — limiares ajustáveis sem reprocessar o vídeo).
function proctorAlerts(p) {
    if (!p || !p.flags) return [];
    const f = p.flags, a = [];
    if (f.absent && f.absent.pct >= 20) a.push("ausência");
    if (f.multiple_people && f.multiple_people.pct >= 20) a.push("+1 pessoa");
    // Celular: calibrado contra vídeo real SEM celular em que o aluno gesticula
    // muito — as mãos perto do rosto geraram 7 frames confirmados (~1%) mesmo após
    // a re-verificação com zoom. Por isso o selo exige ≥5% da prova (uso sustentado)
    // OU ≥10 frames confirmados (provas longas diluem o percentual). Um relance
    // curto não acende o selo, mas segue visível no detalhe por aluno (count/raw_count).
    if (f.phone && (f.phone.pct >= 5 || f.phone.count >= 10)) a.push("celular");
    if (f.hands && f.hands.flag) a.push("mãos fora");
    return a;
}
// Alerta de VOZ: houve pausa longa antes de resposta substancial.
function voiceAlert(v) { return !!(v && v.latency && v.latency.flagged_count > 0); }
// Alerta de CALIBRAÇÃO DE FALA: o pré-teste de captação foi feito e NÃO passou.
function calibrationAlert(c) { return !!(c && c.passed === false); }

// grades_json (mesma forma da entrevista) a partir do relatório do avaliador + os
// pesos das questões. Um único modelo: o avaliador dá um score ANCORADO nos 5
// níveis (0/2,5/5/7,5/10); aqui só arredondamos à âncora mais próxima por robustez.
// Nota final = média ponderada pelos pesos (weightedFinal), sobre as questões do aluno.
const ANCHORS = [0, 2.5, 5, 7.5, 10];
function toAnchor(raw) {
    const s = Number(raw);
    if (!Number.isFinite(s)) return 0;
    return ANCHORS.reduce((best, a) => (Math.abs(a - s) < Math.abs(best - s) ? a : best), 0);
}
function gradesFromReport(report, questions) {
    const pq = report && Array.isArray(report.per_question) ? report.per_question : [];
    if (!pq.length) return null;
    const wById = {};
    for (const q of (questions || [])) wById[q.id] = Number(q.weight) > 0 ? Number(q.weight) : 1;
    const criteria = pq.map(q => ({
        id: q.id, name: q.question, weight: wById[q.id] != null ? wById[q.id] : 1,
        score: toAnchor(q.score), justification: q.comment || "",
    }));
    return { criteria, final: weightedFinal(criteria), computed_at: new Date().toISOString() };
}
// Após avaliar: preenche a NOTA como default (= rubrica per-questão), sem
// sobrescrever ajuste já feito pelo professor. A DEVOLUTIVA não é preenchida
// aqui — passou a ser um passo à parte ("Gerar devolutivas", via LLM), espelhando
// a entrevista. Aplica o critério de penalidade (se ligado) na nota final.
async function applyEvalDefaults(work, submissionId, detail, report, questions) {
    if (!detail || detail.grade_final == null) {
        const grades = gradesFromReport(report, questions);
        if (grades) {
            await applyPenaltyToGrades(work, submissionId, grades, "oral");
            await db.setSubmissionGrades(submissionId, grades);
        }
    }
}

// Garante que o trabalho é uma prova oral antes de seguir.
function requireOral(req, res, next) {
    if (req.work.kind !== "oral_realtime") {
        return res.status(400).json({ error: "este trabalho não é uma prova oral" });
    }
    next();
}

// Ping LEVÍSSIMO para o teste de conexão do aluno (mede RTT antes da prova). Sem
// auth, sem banco — só confirma o caminho até o servidor. no-store p/ não cachear.
router.get("/oral/ping", (_req, res) => { res.set("Cache-Control", "no-store"); res.type("text/plain").send("ok"); });

// Info para a página do professor: config + perguntas extraídas (o professor vê
// perguntas E respostas — é a prova dele) + lista de vozes.
router.get("/w/:workToken/oral/info", requireWorkToken, requireOral, async (req, res) => {
    try {
        const [questions, subs, calibration] = await Promise.all([
            db.getOralQuestions(req.work.id),
            db.listSubmissionsForWork(req.work.id),
            db.getOralCalibration(req.work.id),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            work: {
                name: req.work.name,
                kind: req.work.kind,
                has_exam: req.work.has_exam,
                exam_filename: req.work.has_exam ? await db.getExamFilename(req.work.id) : null,
                question_count: req.work.question_count,
                voice: req.work.voice,
                feedback_guidelines: req.work.feedback_guidelines || "",
                include_interviewer_opinion: req.work.include_interviewer_opinion !== false,
                include_strengths: req.work.include_strengths !== false,
                include_improvement_areas: req.work.include_improvement_areas !== false,
                include_study_suggestions: req.work.include_study_suggestions !== false,
                grade_penalty: req.work.grade_penalty_json || null,
                oral_calibration: calibration || null,
            },
            public_base_url: publicBaseUrl(req),   // origem canônica p/ montar o link do aluno
            questions,
            submissions: (subs || []).map(s => ({
                submission_token: s.submission_token,
                student_label: s.student_label,
                status: s.status,
                is_test: !!s.is_test,
                is_blocked: !!s.is_blocked,
                has_oral_video: !!s.has_oral_video,
                oral_video_parts: Number(s.oral_video_parts_count) || (s.has_oral_video ? 1 : 0),
                has_oral_eval: !!s.has_oral_eval,
                grade: s.grade_final ?? null,
                devolutiva_published: !!s.evaluation_published_at,
                grade_published: !!s.grade_published_at,
                has_oral_proctor: !!s.has_oral_proctor,
                proctor_alerts: proctorAlerts(s.oral_proctor_json),
                voice_alert: voiceAlert(s.oral_voice_json),
                calibration_alert: calibrationAlert(s.oral_calibration_json),
            })),
            voices: VOICES,
        });
    } catch (err) {
        log.error("ORAL", `info failed: ${err.message}`);
        res.status(500).json({ error: "falha ao carregar a prova" });
    }
});

// Download do material da prova que o professor enviou (consulta pós-upload,
// issue #131). Espelha o GET do enunciado da entrevista.
router.get("/w/:workToken/oral/exam-pdf", requireWorkToken, requireOral, async (req, res) => {
    try {
        const blob = await db.getExamBlob(req.work.id);
        if (!blob) return res.status(404).json({ error: "exam not uploaded" });
        const isTxt = (blob.filename || "").toLowerCase().endsWith(".txt");
        res.type(isTxt ? "text/plain; charset=utf-8" : "application/pdf");
        if (blob.filename) res.set("Content-Disposition", `inline; filename="${encodeURIComponent(blob.filename)}"`);
        res.send(blob.pdf);
    } catch (err) {
        log.error("ORAL", `exam-pdf read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read exam" });
    }
});

// Upload do material da prova (PDF ou TXT) → extração das perguntas (modelo
// rápido). PDF vai à OpenAI Files (input_file); TXT entra como texto direto.
router.post("/w/:workToken/oral/exam-pdf", requireWorkToken, requireOral, examUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const name = (req.file.originalname || "").toLowerCase();
    const mime = req.file.mimetype || "";
    const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
    const isTxt = mime === "text/plain" || name.endsWith(".txt");
    if (!isPdf && !isTxt) return res.status(400).json({ error: "envie um arquivo PDF ou TXT" });
    try {
        // Guarda os bytes da fonte (serve de flag has_exam; col. exam_pdf é genérica).
        await db.setExamPdf(req.work.id, req.file.buffer, req.file.originalname);
        // Extrai perguntas + respostas esperadas (gabarito). A rubrica de pontuação é
        // gerada depois, a partir das respostas (OralRubricBuilderAgent).
        let questions;
        if (isTxt) {
            const text = req.file.buffer.toString("utf-8").replace(/^\uFEFF/, "").trim();
            if (!text) return res.status(400).json({ error: "o arquivo .txt está vazio" });
            questions = await oralExamExtractorAgent.extract({ examText: text, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        } else {
            const examFile = await openai.files.create({
                file: await OpenAI.toFile(req.file.buffer, req.file.originalname || "prova.pdf"),
                purpose: "user_data",
            });
            questions = await oralExamExtractorAgent.extract({ examFileId: examFile.id, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        }
        // Peso 1 default; rubrica vazia → rubric_stale=true (o professor gera). Novas
        // (sem id) recebem ids frescos do contador.
        questions = questions.map(q => ({ ...q, rubric: "", weight: 1 }));
        const cleaned = await db.setOralQuestions(req.work.id, questions);
        // Calibração de fala gerada AUTOMÁTICA no upload, em silêncio (o professor não
        // lida com calibração nem vê/edita a frase — some o card de calibração).
        // Best-effort: se falhar, o upload das perguntas NÃO falha.
        let calibrationGenerated = false;
        try {
            const items = cleaned
                .map(q => ({ question: q.question, answer: q.answer }))
                .filter(it => String(it.question || "").trim() || String(it.answer || "").trim());
            if (items.length) {
                const { sentence, key_terms } = await oralCalibrationAgent.build({ items, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
                await db.setOralCalibration(req.work.id, { sentence, key_terms });
                calibrationGenerated = true;
            }
        } catch (calErr) {
            log.error("ORAL", `exam calibration auto-gen failed work=${req.work.work_token}: ${calErr.message}`);
        }
        log.info("ORAL", `exam uploaded+extracted work=${req.work.work_token} type=${isTxt ? "txt" : "pdf"} questions=${cleaned.length}`);
        res.json({ ok: true, count: cleaned.length, questions: cleaned, calibration_generated: calibrationGenerated });
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

// Perguntas + respostas + rubricas, editadas nos dois editores que COMPARTILHAM a
// mesma lista: a Configuração (enunciado + resposta) e a "Rubrica por questão" na
// aba de avaliação (peso + rubrica). Salva o array COMPLETO. Cada questão carrega
// seu `id` estável; db.setOralQuestions preserva ids, calcula rubric_stale por diff.
router.post("/w/:workToken/oral/questions", requireWorkToken, requireOral, async (req, res) => {
    const raw = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (!raw) return res.status(400).json({ error: "questions (array) required" });
    if (!raw.some(q => String(q?.question || "").trim())) return res.status(400).json({ error: "nenhuma pergunta válida (cada pergunta precisa de enunciado)" });
    try {
        // Salvar é RÁPIDO (sem LLM): só persiste. (A checagem advisory das rubricas
        // não roda mais a cada save — deixava o salvar lento.)
        const cleaned = await db.setOralQuestions(req.work.id, raw);
        log.info("ORAL", `questões salvas work=${req.work.work_token} n=${cleaned.length}`);
        res.json({ ok: true, count: cleaned.length, questions: cleaned });
    } catch (err) {
        log.error("ORAL", `save questions failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar as perguntas" });
    }
});

// Geração de RUBRICAS (a partir das respostas esperadas), em lote — NDJSON, espelha
// evaluate-all. scope=stale → só as pendentes/vazias (com resposta); scope=all →
// todas com resposta (regenera). Requer resposta esperada não-vazia por questão.
router.post("/w/:workToken/oral/rubrics/generate", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    let started = false;
    try {
        const scope = req.query.scope === "all" || req.body?.scope === "all" ? "all" : "stale";
        const all = await db.getOralQuestions(req.work.id);
        const targets = all.filter(q => String(q.answer || "").trim() && (scope === "all" || q.rubric_stale || !String(q.rubric || "").trim()));
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (o) => res.write(JSON.stringify(o) + "\n");
        send({ type: "start", ids: targets.map(q => q.id) });
        let generated = 0; const errors = [];
        await mapPool(targets, 4, async (q) => {
            try {
                const { rubric, weight } = await oralRubricBuilderAgent.build({ question: q.question, answer: q.answer, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
                await db.updateOralQuestionRubric(req.work.id, q.id, { rubric, weight });
                generated++;
                send({ type: "item", id: q.id, ok: true });
            } catch (e) {
                errors.push({ id: q.id, error: e.message });
                log.error("ORAL", `rubric gen item failed q=${q.id}: ${e.message}`);
                send({ type: "item", id: q.id, ok: false, error: e.message });
            }
        });
        const questions = await db.getOralQuestions(req.work.id);
        log.info("ORAL", `rubrics generate work=${req.work.work_token} scope=${scope} geradas=${generated}/${targets.length}`);
        send({ type: "done", generated, candidates: targets.length, errors, questions });
        res.end();
    } catch (err) {
        log.error("ORAL", `rubrics generate failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; }
        res.status(500).json({ error: "falha ao gerar rubricas", detail: err.message });
    }
});

// Geração de rubrica de UMA questão (botão por linha). Requer resposta esperada.
router.post("/w/:workToken/oral/questions/:qid/rubric/generate", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    try {
        const qid = Number(req.params.qid);
        const q = (await db.getOralQuestions(req.work.id)).find(x => Number(x.id) === qid);
        if (!q) return res.status(404).json({ error: "questão não encontrada" });
        if (!String(q.answer || "").trim()) return res.status(409).json({ error: "esta questão não tem resposta esperada — escreva a rubrica à mão ou preencha a resposta" });
        const { rubric, weight } = await oralRubricBuilderAgent.build({ question: q.question, answer: q.answer, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        const updated = await db.updateOralQuestionRubric(req.work.id, qid, { rubric, weight });
        res.json({ ok: true, question: updated });
    } catch (err) {
        log.error("ORAL", `rubric gen (single) failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a rubrica", detail: err.message });
    }
});

// --- Frase de CALIBRAÇÃO DE FALA (pré-teste de captação). Salvar (edição do
// professor) e Gerar (a partir das perguntas/respostas). Vazio = pré-teste
// desligado para o trabalho. ---
router.post("/w/:workToken/oral/calibration", requireWorkToken, requireOral, express.json({ limit: "16kb" }), async (req, res) => {
    try {
        const saved = await db.setOralCalibration(req.work.id, {
            sentence: String(req.body?.sentence ?? ""),
            key_terms: Array.isArray(req.body?.key_terms) ? req.body.key_terms : [],
        });
        log.info("ORAL", `calibration saved work=${req.work.work_token} ${saved ? "on" : "off"}`);
        res.json({ ok: true, calibration: saved });
    } catch (err) {
        log.error("ORAL", `save calibration failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a frase de calibração" });
    }
});
router.post("/w/:workToken/oral/calibration/generate", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    try {
        const qs = await db.getOralQuestions(req.work.id);
        const items = qs
            .map(q => ({ question: q.question, answer: q.answer }))
            .filter(it => String(it.question || "").trim() || String(it.answer || "").trim());
        if (!items.length) return res.status(409).json({ error: "a prova não tem perguntas para extrair termos" });
        const { sentence, key_terms } = await oralCalibrationAgent.build({ items, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        const saved = await db.setOralCalibration(req.work.id, { sentence, key_terms });
        log.info("ORAL", `calibration generated work=${req.work.work_token} terms=${key_terms.length}`);
        res.json({ ok: true, calibration: saved });
    } catch (err) {
        log.error("ORAL", `gen calibration failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a frase de calibração", detail: err.message });
    }
});

// --- Avaliação por aluno (professor) — espelha a entrevista, mas a devolutiva
// e a nota são MANUAIS (sem geração por IA). A avaliação compara a transcrição
// das respostas do aluno com o gabarito. ---

router.post("/w/:workToken/oral/submissions/:subToken/evaluate", requireWorkToken, requireProfessorSubmission, requireWithinBudget, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const [asked, detail, workQ] = await Promise.all([
            db.getOralAsked(req.submission.id),
            db.getOralSubmissionDetail(req.submission.id),
            db.getOralQuestions(req.work.id),
        ]);
        // Avalia SÓ as perguntas feitas a este aluno (fallback: todas, p/ provas
        // antigas), enriquecidas com a rubrica + peso ATUAIS do trabalho (por id).
        const byId = {}; for (const q of workQ) byId[q.id] = q;
        const questions = (asked && asked.length ? asked : workQ)
            .map(q => byId[q.id] ? { ...q, rubric: byId[q.id].rubric, weight: byId[q.id].weight } : { ...q, weight: Number(q.weight) > 0 ? Number(q.weight) : 1 });
        const transcript = Array.isArray(detail?.oral_transcript) ? detail.oral_transcript : [];
        if (!questions.length) return res.status(409).json({ error: "a prova não tem perguntas" });
        if (!transcript.length) return res.status(409).json({ error: "sem transcrição — o aluno ainda não realizou a prova" });
        const semRubrica = questions.filter(q => !String(q.rubric || "").trim());
        if (semRubrica.length) return res.status(409).json({ error: `gere ou escreva a rubrica de ${semRubrica.length} questão(ões) antes de avaliar (aba Avaliação & notas)` });
        const report = await oralExamEvaluatorAgent.evaluate({
            questions, transcript, meterCtx: { openai: clientForWork(req.work), workId: req.work.id, submissionId: req.submission.id },
        });
        await db.setOralEvaluation(req.submission.id, report);
        await applyEvalDefaults(req.work, req.submission.id, detail, report, questions); // nota default (+ penalidade)
        const grades = await db.getSubmissionGrades(req.submission.id); // já com penalidade, se ligada
        res.json({ ok: true, evaluation: report, grade: grades?.final ?? null, grades });
    } catch (err) {
        log.error("ORAL", `evaluate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar", detail: err.message });
    }
});

router.get("/w/:workToken/oral/submissions/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const [d, grades, asked, workQ] = await Promise.all([
            db.getOralSubmissionDetail(req.submission.id),
            db.getSubmissionGrades(req.submission.id),
            db.getOralAsked(req.submission.id),
            db.getOralQuestions(req.work.id),
        ]);
        // Questões feitas a este aluno, enriquecidas com peso/enunciado atuais (por
        // id) — usadas p/ semear o grid de nota manual antes de avaliar.
        const wById = {}; for (const q of workQ) wById[q.id] = q;
        const questions = (asked && asked.length ? asked : workQ).map(q => ({
            id: q.id, question: (wById[q.id]?.question ?? q.question) || "",
            weight: Number(wById[q.id]?.weight) > 0 ? Number(wById[q.id].weight) : (Number(q.weight) > 0 ? Number(q.weight) : 1),
        }));
        // Número de exibição por questão = POSIÇÃO na lista completa (1..N), igual ao
        // que o professor vê nos editores. Assim o relatório do aluno bate com a rubrica.
        const question_numbers = {}; workQ.forEach((q, i) => { question_numbers[q.id] = i + 1; });
        res.set("Cache-Control", "no-store");
        res.json({
            question_numbers,
            student_label: req.submission.student_label,
            completion_reason: d?.completion_reason || null,
            has_oral_video: !!d?.has_oral_video,
            transcript: Array.isArray(d?.oral_transcript) ? d.oral_transcript : [],
            evaluation: d?.oral_eval_json || null,
            devolutiva: d?.oral_devolutiva || "",
            grade: d?.grade_final ?? null,
            grades: grades || null,
            questions,
            devolutiva_published: !!d?.evaluation_published_at,
            grade_published: !!d?.grade_published_at,
            proctor: d?.oral_proctor_json || null,
            voice: d?.oral_voice_json || null,
            calibration: d?.oral_calibration_json || null,
            student_comment: d?.student_comment || null,
            feedback_guidelines: req.work.feedback_guidelines || "",
        });
    } catch (err) { log.error("ORAL", `detail failed: ${err.message}`); res.status(500).json({ error: "falha ao carregar" }); }
});

router.put("/w/:workToken/oral/submissions/:subToken/devolutiva", requireWorkToken, requireProfessorSubmission, express.json({ limit: "64kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try { await db.setOralDevolutiva(req.submission.id, String(req.body?.text ?? "")); res.json({ ok: true }); }
    catch (err) { log.error("ORAL", `devolutiva failed: ${err.message}`); res.status(500).json({ error: "falha ao salvar devolutiva" }); }
});

// Gera a devolutiva de UM aluno via LLM (StudentFeedbackAgent), a partir da
// avaliação + diretrizes. Espelha /student-version da entrevista, inclusive o
// override ad-hoc: body { guidelines: string|null } vale SÓ para esta geração
// (não altera o padrão do trabalho). Sem o campo, usa as diretrizes do trabalho.
// Com ?force=1 sobrescreve a devolutiva atual; sem force, exige que esteja vazia.
router.post("/w/:workToken/oral/submissions/:subToken/devolutiva/derive", requireWorkToken, requireProfessorSubmission, requireWithinBudget, express.json({ limit: "32kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const force = req.query.force === "1" || req.body?.force === true;
    const hasOverride = req.body && Object.prototype.hasOwnProperty.call(req.body, "guidelines");
    const rawOverride = req.body?.guidelines;
    if (hasOverride && rawOverride !== null && typeof rawOverride !== "string") {
        return res.status(400).json({ error: "guidelines deve ser string ou null" });
    }
    const guidelinesOverride = hasOverride
        ? (typeof rawOverride === "string" && rawOverride.trim() ? rawOverride.trim() : null)
        : undefined;
    try {
        const r = await deriveOralDevolutivaNow(req.work, req.submission.id, { force, guidelinesOverride });
        if (r.reason === "no_eval") return res.status(409).json({ error: "avalie a prova antes de gerar a devolutiva" });
        const d = await db.getOralSubmissionDetail(req.submission.id);
        res.json({ ok: true, generated: !!r.generated, devolutiva: d?.oral_devolutiva || "" });
    } catch (err) {
        log.error("ORAL", `devolutiva derive failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a devolutiva", detail: err.message });
    }
});


// Edição manual dos scores por questão (grid de nota). Sobrescreve os scores em
// grades_json, marca como manual, recomputa a nota final ponderada.
router.put("/w/:workToken/oral/submissions/:subToken/grades", requireWorkToken, requireProfessorSubmission, express.json({ limit: "16kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const scores = Array.isArray(req.body?.scores) ? req.body.scores : null;
    if (!scores) return res.status(400).json({ error: "scores (array) required" });
    try {
        let grades = await db.getSubmissionGrades(req.submission.id);
        if (!grades || !Array.isArray(grades.criteria)) {
            // Sem cálculo automático: semeia as questões (feitas ao aluno) com notas
            // em branco para o professor lançar à mão. Pesos = os atuais do trabalho.
            const [asked, workQ] = await Promise.all([db.getOralAsked(req.submission.id), db.getOralQuestions(req.work.id)]);
            const wById = {}; for (const q of workQ) wById[q.id] = Number(q.weight) > 0 ? Number(q.weight) : 1;
            const base = (asked && asked.length ? asked : workQ);
            if (!base.length) return res.status(409).json({ error: "a prova não tem perguntas" });
            grades = {
                criteria: base.map(q => ({ id: q.id, name: q.question, weight: wById[q.id] != null ? wById[q.id] : 1, score: null, justification: "" })),
                final: null, computed_at: new Date().toISOString(),
            };
        }
        const byId = {};
        for (const s of scores) { const v = Number(s.score); if (Number.isFinite(v)) byId[s.id] = Math.max(0, Math.min(10, Math.round(v * 10) / 10)); }
        const criteria = grades.criteria.map(c => (byId[c.id] != null ? { ...c, score: byId[c.id], manual: true } : c));
        const updated = { ...grades, criteria, final: weightedFinal(criteria) };
        await db.setSubmissionGrades(req.submission.id, updated);
        res.json({ ok: true, grades: updated });
    } catch (err) { log.error("ORAL", `grades edit failed: ${err.message}`); res.status(500).json({ error: "falha ao salvar notas" }); }
});

router.post("/w/:workToken/oral/submissions/:subToken/publish", requireWorkToken, requireProfessorSubmission, express.json({ limit: "8kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        if (typeof req.body?.devolutiva === "boolean") await db.publishOralDevolutiva(req.submission.id, req.body.devolutiva);
        if (typeof req.body?.grade === "boolean") await db.publishOralGrade(req.submission.id, req.body.grade);
        res.json({ ok: true });
    } catch (err) { log.error("ORAL", `publish failed: ${err.message}`); res.status(500).json({ error: "falha ao publicar" }); }
});

// Proctoring local por vídeo (pós-prova): amostra frames e gera flags para
// revisão humana (ausência / mais de uma pessoa / celular / mãos não visíveis).
// Roda local (onnxruntime + ffmpeg); o vídeo não vai a serviço externo.
router.post("/w/:workToken/oral/submissions/:subToken/proctor", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const parts = await db.getOralVideoParts(req.submission.id);
        if (!parts.length) return res.status(409).json({ error: "esta prova não tem vídeo gravado" });
        const report = await analyzeOralVideoParts(parts);
        await db.setOralProctor(req.submission.id, report);
        res.json({ ok: true, proctor: report });
    } catch (err) {
        log.error("ORAL", `proctor failed: ${err.message}`);
        res.status(500).json({ error: "falha na análise do vídeo", detail: err.message });
    }
});

// --- Lote (professor): avaliar todas + publicar/despublicar em massa ---

// Avalia todas as provas realizadas. Sem ?force, pula as que já têm relatório;
// com ?force=1, reavalia todas. Sequencial (uma chamada de LLM por aluno).
router.post("/w/:workToken/oral/evaluate-all", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    let started = false; // se já mandamos headers (streaming), não dá mais p/ responder 500
    try {
        const force = req.query.force === "1" || req.body?.force === true;
        const allQuestions = await db.getOralQuestions(req.work.id);
        if (!allQuestions.length) return res.status(409).json({ error: "a prova não tem perguntas" });
        const byId = {}; for (const q of allQuestions) byId[q.id] = q;
        const subs = await db.listOralSubmissionsForEval(req.work.id, force);

        // Streaming NDJSON: uma linha JSON por evento, sobre o mesmo POST. O cliente
        // põe ampulheta nas linhas anunciadas em "start" e troca cada uma pela nota
        // assim que o respectivo "item" chega. Como os headers já vão cedo, erros
        // depois do start são tratados por item (não dá p/ mandar status 500).
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (obj) => res.write(JSON.stringify(obj) + "\n");
        send({ type: "start", tokens: subs.map(s => s.submission_token) });

        let evaluated = 0;
        const errors = [];
        // Avalia em PARALELO com concorrência limitada (mapPool): cada avaliação é
        // uma chamada de raciocínio de dezenas de segundos; em série, N alunos =
        // N×esse tempo. O pool reduz o tempo de parede ~Nx sem disparar todas de
        // uma vez (evita estourar limite de taxa da OpenAI). A fn faz o `send` por
        // item (streaming), então trata o próprio erro.
        const ORAL_EVAL_CONCURRENCY = 4;
        await mapPool(subs, ORAL_EVAL_CONCURRENCY, async (s) => {
            try {
                const [asked, detail] = await Promise.all([db.getOralAsked(s.id), db.getOralSubmissionDetail(s.id)]);
                // só as perguntas feitas a este aluno, com rubrica + peso atuais (por id)
                const questions = (asked && asked.length ? asked : allQuestions)
                    .map(q => byId[q.id] ? { ...q, rubric: byId[q.id].rubric, weight: byId[q.id].weight } : { ...q, weight: Number(q.weight) > 0 ? Number(q.weight) : 1 });
                const transcript = Array.isArray(detail?.oral_transcript) ? detail.oral_transcript : [];
                if (!transcript.length) {
                    // Item pulado: avisa o cliente p/ tirar a ampulheta dessa linha.
                    send({ type: "item", submission_token: s.submission_token, ok: false, error: "sem transcrição" });
                    return;
                }
                if (questions.some(q => !String(q.rubric || "").trim())) {
                    send({ type: "item", submission_token: s.submission_token, ok: false, error: "rubrica faltando" });
                    return;
                }
                const report = await oralExamEvaluatorAgent.evaluate({
                    questions, transcript, meterCtx: { openai: clientForWork(req.work), workId: req.work.id, submissionId: s.id },
                });
                await db.setOralEvaluation(s.id, report);
                await applyEvalDefaults(req.work, s.id, detail, report, questions); // nota default (+ penalidade)
                evaluated++;
                // Lê a nota efetivamente gravada (applyEvalDefaults não sobrescreve
                // ajuste manual do professor, então o default pode não valer).
                const after = await db.getOralSubmissionDetail(s.id);
                send({ type: "item", submission_token: s.submission_token, ok: true, has_oral_eval: true, grade: after?.grade_final ?? null });
            } catch (e) {
                errors.push({ submission: s.submission_token, label: s.student_label, error: e.message });
                log.error("ORAL", `evaluate-all item failed sub=${s.submission_token}: ${e.message}`);
                send({ type: "item", submission_token: s.submission_token, ok: false, error: e.message });
            }
        });
        log.info("ORAL", `evaluate-all work=${req.work.work_token} avaliadas=${evaluated}/${subs.length} force=${force} conc=${ORAL_EVAL_CONCURRENCY}`);
        send({ type: "done", evaluated, candidates: subs.length, errors });
        res.end();
    } catch (err) {
        log.error("ORAL", `evaluate-all failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; } // headers já enviados: só encerra
        res.status(500).json({ error: "falha na avaliação em lote", detail: err.message });
    }
});

// Lote: gera as devolutivas (LLM) das provas já avaliadas. Sem force, pula quem
// já tem devolutiva escrita; com ?force=1, regenera todas. Concorrência limitada,
// streaming NDJSON como o evaluate-all.
router.post("/w/:workToken/oral/evaluations/student-versions", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    let started = false;
    try {
        const force = req.query.force === "1" || req.body?.force === true;
        const subs = await db.listOralSubmissionsForDevolutiva(req.work.id, force);
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (obj) => res.write(JSON.stringify(obj) + "\n");
        send({ type: "start", tokens: subs.map(s => s.submission_token) });

        let generated = 0;
        const errors = [];
        const CONC = 4;
        await mapPool(subs, CONC, async (s) => {
            try {
                const r = await deriveOralDevolutivaNow(req.work, s.id, { force });
                if (r.generated) generated++;
                send({ type: "item", submission_token: s.submission_token, ok: true, generated: !!r.generated, skipped: !!r.skipped });
            } catch (e) {
                errors.push({ submission: s.submission_token, label: s.student_label, error: e.message });
                log.error("ORAL", `student-versions item failed sub=${s.submission_token}: ${e.message}`);
                send({ type: "item", submission_token: s.submission_token, ok: false, error: e.message });
            }
        });
        log.info("ORAL", `student-versions work=${req.work.work_token} geradas=${generated}/${subs.length} force=${force}`);
        send({ type: "done", generated, candidates: subs.length, errors });
        res.end();
    } catch (err) {
        log.error("ORAL", `student-versions failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; }
        res.status(500).json({ error: "falha ao gerar devolutivas em lote", detail: err.message });
    }
});

// Publica/despublica devolutivas ou notas em massa. Corpo: {target:'devolutiva'|'grade', on:bool}.
router.post("/w/:workToken/oral/publish-all", requireWorkToken, requireOral, express.json({ limit: "8kb" }), async (req, res) => {
    const target = req.body?.target;
    const on = req.body?.on === true;
    if (target !== "devolutiva" && target !== "grade") return res.status(400).json({ error: "target inválido (devolutiva|grade)" });
    try {
        const affected = target === "devolutiva"
            ? await db.publishAllOralDevolutiva(req.work.id, on)
            : await db.publishAllOralGrade(req.work.id, on);
        log.info("ORAL", `publish-all work=${req.work.work_token} target=${target} on=${on} affected=${affected}`);
        res.json({ ok: true, affected });
    } catch (err) {
        log.error("ORAL", `publish-all failed: ${err.message}`);
        res.status(500).json({ error: "falha ao publicar em lote" });
    }
});

// Lote: proctoring por VÍDEO de todas as provas com vídeo gravado. Sem ?force,
// pula as já analisadas; com ?force=1, reanalisa todas. Sequencial (cada vídeo:
// ffmpeg + 2 modelos por frame), tudo local — o vídeo não vai a serviço externo.
router.post("/w/:workToken/oral/proctor-all", requireWorkToken, requireOral, async (req, res) => {
    let started = false; // se já mandamos headers (streaming), não dá mais p/ responder 500
    try {
        const force = req.query.force === "1" || req.body?.force === true;
        const subs = await db.listOralSubmissionsForProctor(req.work.id, force);

        // Streaming NDJSON (mesmo protocolo do evaluate-all): a coluna Alertas de
        // cada aluno candidato vira ampulheta no "start" e é preenchida quando o
        // respectivo "item" chega. SERIAL de propósito (cada vídeo: ffmpeg + 2
        // modelos por frame); medimos o tempo por vídeo p/ avaliar paralelizar depois.
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (obj) => res.write(JSON.stringify(obj) + "\n");
        send({ type: "start", tokens: subs.map(s => s.submission_token) });

        let analyzed = 0;
        const errors = [];
        const perVideoMs = [];
        const t0 = Date.now();
        for (const s of subs) {
            try {
                const parts = await db.getOralVideoParts(s.id);
                if (!parts.length) {
                    // Item pulado: avisa o cliente p/ tirar a ampulheta dessa linha.
                    send({ type: "item", submission_token: s.submission_token, ok: false, error: "sem vídeo" });
                    continue;
                }
                const tv = Date.now();
                const report = await analyzeOralVideoParts(parts);
                await db.setOralProctor(s.id, report);
                const elapsed = Date.now() - tv;
                perVideoMs.push(elapsed);
                analyzed++;
                // Mesmos cálculos que /oral/info: alertas de vídeo do report e alerta
                // de voz do oral_voice_json gravado para o aluno.
                const detail = await db.getOralSubmissionDetail(s.id);
                send({
                    type: "item", submission_token: s.submission_token, ok: true, has_oral_proctor: true,
                    proctor_alerts: proctorAlerts(report),
                    voice_alert: voiceAlert(detail?.oral_voice_json),
                });
            } catch (e) {
                errors.push({ submission: s.submission_token, label: s.student_label, error: e.message });
                log.error("ORAL", `proctor-all item failed sub=${s.submission_token}: ${e.message}`);
                send({ type: "item", submission_token: s.submission_token, ok: false, error: e.message });
            }
        }
        const elapsedTotal = Date.now() - t0;
        log.info("ORAL", `proctor-all work=${req.work.work_token} analisados=${analyzed}/${subs.length} force=${force} tempo_total_ms=${elapsedTotal} por_video_ms=[${perVideoMs.join(", ")}]`);
        send({ type: "done", analyzed, candidates: subs.length, errors, elapsed_total_ms: elapsedTotal, per_video_ms: perVideoMs });
        res.end();
    } catch (err) {
        log.error("ORAL", `proctor-all failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; } // headers já enviados: só encerra
        res.status(500).json({ error: "falha no proctoring em lote", detail: err.message });
    }
});

// --- Lado do ALUNO (Realtime) ---


// Cria um client secret EFÊMERO da OpenAI Realtime, com a sessão já configurada
// (modelo, voz, instruções com as perguntas, VAD de servidor, transcrição da
// fala do aluno). A nossa OPENAI_API_KEY nunca vai ao navegador — só o segredo
// efêmero de ~1 min. Usamos fetch cru para não acoplar à versão do SDK.
async function mintRealtimeSecret({ instructions, voice, apiKey = process.env.OPENAI_API_KEY }) {
    const body = {
        session: {
            type: "realtime",
            model: REALTIME_MODEL,
            instructions,
            audio: {
                input: {
                    // Redução de ruído antes do VAD (barulho ambiente não dispara corte falso).
                    noise_reduction: { type: "far_field" },
                    transcription: { model: "gpt-4o-transcribe" },
                    // VAD semântico paciente: tolera pausas para pensar e ignora ruído
                    // breve antes de assumir fala.
                    turn_detection: { type: "semantic_vad", eagerness: "low" },
                },
                output: { voice },
            },
        },
    };
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
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
        const instructions = buildExamInstructions(sampled, req.work.name);
        const secret = await mintRealtimeSecret({ instructions, voice, apiKey: apiKeyForWork(req.work) });
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

// Status para a página do aluno: já realizou a prova? (teste nunca trava).
router.get("/s/:submissionToken/oral/status", requireSubmissionToken, (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const done = !!req.submission.completion_reason && !req.submission.is_test;
    res.json({ done, is_test: !!req.submission.is_test });
});

// --- Calibração de fala (pré-teste de captação, ANTES da sessão de voz) ---
// Config p/ a tela do aluno: a frase-alvo a ler e quantas tentativas. Sem frase
// no trabalho, enabled=false → o aluno pula direto para a prova (fail-open).
router.get("/s/:submissionToken/oral/calibrate-config", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const calib = await db.getOralCalibration(req.work.id);
        res.set("Cache-Control", "no-store");
        res.json({ enabled: !!calib, sentence: calib?.sentence || null, max_attempts: MAX_CALIB_ATTEMPTS });
    } catch (err) { log.error("ORAL", `calibrate-config failed: ${err.message}`); res.status(500).json({ error: "falha" }); }
});

// Recebe a repetição gravada do aluno, transcreve (o MESMO gpt-4o-transcribe da
// correção) e pontua contra a frase-alvo. NUNCA bloqueia: após MAX_CALIB_ATTEMPTS
// o aluno segue mesmo assim; o resultado fica registrado para o professor.
const CALIB_ADVICE = "Fale em volume médio, num ritmo tranquilo (sem correr) e sem cortar o fim das palavras — assim a captação transcreve melhor a sua fala.";
router.post("/s/:submissionToken/oral/calibrate", requireSubmissionToken, calibUpload.single("file"), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
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

        log.info("ORAL", `calibrate submission=${req.submission.submission_token} attempt=${attempt} ok=${ok} wer=${wer == null ? "—" : wer.toFixed(2)} missed=${missedTerms.length}`);
        res.json({
            ok, attempt, attempts_left: Math.max(0, MAX_CALIB_ATTEMPTS - attempt),
            wer, missed_terms: missedTerms, transcript: text, advice: ok ? null : CALIB_ADVICE,
        });
    } catch (err) {
        log.error("ORAL", `calibrate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao verificar a captação", detail: err.message });
    }
});

// Aluno lê o que foi PUBLICADO (devolutiva e/ou nota). O relatório de
// comparação ao gabarito é professor-only e nunca é exposto aqui.
router.get("/s/:submissionToken/oral/result", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const d = await db.getOralSubmissionDetail(req.submission.id);
        res.json({
            devolutiva: d?.evaluation_published_at ? (d.oral_devolutiva || "") : null,
            grade: d?.grade_published_at ? (d.grade_final ?? null) : null,
        });
    } catch (err) { log.error("ORAL", `result failed: ${err.message}`); res.status(500).json({ error: "falha" }); }
});

// Revisão pós-prova (LGPD self-access), espelha o GET /s/:t/review da entrevista:
// dentro da janela de revisão o aluno vê a TRANSCRIÇÃO da própria prova e pode
// deixar UM comentário ao professor. A devolutiva/nota publicadas vêm à parte,
// pelo /oral/result (não expiram com a janela). Após a janela: 410.
router.get("/s/:submissionToken/oral/review", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    if (!req.submission.completion_reason) {
        return res.status(409).json({ error: "not_finalized", detail: "Prova ainda não foi realizada." });
    }
    const win = reviewWindowState(req.submission);
    if (win.expired) return res.status(410).json({ error: "review_window_expired", deadline: win.deadline });
    try {
        const d = await db.getOralSubmissionDetail(req.submission.id);
        res.set("Cache-Control", "no-store");
        res.json({
            submission: {
                student_label: req.submission.student_label,
                completion_reason: req.submission.completion_reason,
                completed_at: req.submission.completed_at,
            },
            review_window: { deadline: win.deadline, days: REVIEW_WINDOW_DAYS },
            comment: {
                value: d?.student_comment ?? null,
                locked: !!d?.student_comment,
            },
            transcript: Array.isArray(d?.oral_transcript) ? d.oral_transcript : [],
            calibration_flagged: calibrationAlert(d?.oral_calibration_json),
        });
    } catch (err) {
        log.error("ORAL", `review failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_load_review" });
    }
});

// Comentário do aluno ao professor. Single-shot (uma vez que student_comment
// estiver setado, não muda), dentro da janela de revisão. Reusa a MESMA coluna
// e o MESMO helper da entrevista.
router.post("/s/:submissionToken/oral/comment", requireSubmissionToken, express.json({ limit: "16kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    if (!req.submission.completion_reason) return res.status(409).json({ error: "not_finalized" });
    const win = reviewWindowState(req.submission);
    if (win.expired) return res.status(410).json({ error: "review_window_expired" });
    // Single-shot: lê o valor atual do banco (o req.submission da middleware não
    // carrega student_comment).
    const existing = await db.getOralSubmissionDetail(req.submission.id);
    if (existing?.student_comment) {
        return res.status(409).json({ error: "comment_already_submitted", detail: "Comentário já foi enviado e não pode ser editado." });
    }
    const raw = req.body?.comment;
    if (typeof raw !== "string") return res.status(400).json({ error: "comment é obrigatório (string)" });
    const trimmed = raw.trim().slice(0, MAX_COMMENT_LEN);
    if (!trimmed) return res.status(400).json({ error: "comment vazio" });
    try {
        await db.setSubmissionStudentComment(req.submission.id, trimmed);
        log.info("ORAL", `comment submitted token=${req.submission.submission_token} chars=${trimmed.length}`);
        res.json({ ok: true, comment: trimmed });
    } catch (err) {
        log.error("ORAL", `comment submit failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_save_comment" });
    }
});

// O portão de SETUP (posição/distância/mãos/celular) agora roda 100% no NAVEGADOR
// (MediaPipe WASM em static/oral-student.html) — sem chamar o servidor. Não há
// mais rota de position-check aqui (a análise de vídeo PÓS-prova segue no servidor).

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
    try {
        if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
        if (!req.file) return res.status(400).json({ error: "file required" });
        const ext = extFromMimetype(req.file.mimetype);
        // Chave ÚNICA por segmento (multi-parte): o original e cada retomada são
        // preservados. Antes usava chave fixa por token → a retomada sobrescrevia
        // o segmento anterior e o professor só via a última gravação.
        const key = `oral-video/${req.submission.submission_token}-${Date.now()}.${ext}`;
        const buffer = await fs.promises.readFile(req.file.path); // do temporário em disco
        const r = await putAudio({ key, buffer, mimetype: req.file.mimetype });
        if (!r.stored) {
            log.error("ORAL", `vídeo não armazenado submission=${req.submission.submission_token}: ${r.reason}`);
            return res.status(502).json({ error: "falha ao armazenar o vídeo", detail: r.reason });
        }
        await db.appendOralVideoPart(req.submission.id, key);
        log.info("ORAL", `segmento de vídeo armazenado submission=${req.submission.submission_token} key=${key} bytes=${buffer.length}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("ORAL", `video upload failed: ${err.message}`);
        res.status(500).json({ error: "falha no upload do vídeo", detail: err.message });
    } finally {
        if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    }
});

// Professor assiste ao vídeo gravado (avaliação posterior). Auth por token do
// trabalho + submissão pertencente a ele.
router.get("/w/:workToken/oral/video/:subToken/:idx?", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    try {
        const parts = await db.getOralVideoParts(req.submission.id);
        const idx = req.params.idx != null ? parseInt(req.params.idx, 10) : 0;
        const key = parts[Number.isFinite(idx) ? idx : 0];
        if (!key) return res.status(404).json({ error: "sem vídeo para esta submissão" });
        const ext = key.split(".").pop();
        const type = (ext === "mp4" || ext === "m4a") ? "video/mp4" : "video/webm";
        // Backend local: sendFile resolve HTTP Range / seek do vídeo nativamente.
        const local = await localFilePath(key);
        if (local) { res.type(type); return res.sendFile(local); }
        // Fallback (ex.: replit): Range manual sobre o buffer, para permitir seek.
        const buf = await readAllBytes(key);
        if (!buf) return res.status(404).json({ error: "vídeo indisponível no armazenamento" });
        const total = buf.length;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", type);
        const range = req.headers.range;
        if (!range) { res.setHeader("Content-Length", total); return res.end(buf); }
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end) { res.status(416).setHeader("Content-Range", `bytes */${total}`); return res.end(); }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", end - start + 1);
        return res.end(buf.subarray(start, end + 1));
    } catch (err) {
        log.error("ORAL", `video serve failed: ${err.message}`);
        res.status(500).json({ error: "falha ao servir o vídeo" });
    }
});

export default router;

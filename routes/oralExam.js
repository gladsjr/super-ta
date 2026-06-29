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
import * as db from "../lib/db.js";
import { openai } from "../lib/openaiClient.js";
import { oralExamExtractorAgent, oralExamEvaluatorAgent, oralExamAspectsAgent } from "../lib/agents.js";
import { putAudio, localFilePath, readAllBytes, extFromMimetype } from "../lib/audioStore.js";
import { VOICES, isValidVoice } from "../config/voices.js";
import { isValidQuestionCount, REALTIME_MODEL } from "../lib/config.js";
import { CONSENT_VERSION } from "../config/consent.js";
import { sampleKeepingOrder, buildExamInstructions } from "../lib/oralRealtime.js";
import { analyzeOralVideo } from "../lib/proctor.js";
import log from "../lib/logger.js";

const router = express.Router();
const examUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
// Vídeo da prova (até 300MB): em DISCO (não memória). Com memoryStorage, 50
// uploads simultâneos seguram até 300MB cada na RAM durante toda a transferência
// (lenta no mobile). Em disco, a transferência não pesa na RAM; só lemos o arquivo
// na hora de mandar pro storage, e apagamos o temporário em seguida.
const videoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });

// Alertas de proctoring por VÍDEO para a lista do professor (resumo conservador,
// calculado dos flags brutos — limiares ajustáveis sem reprocessar o vídeo).
function proctorAlerts(p) {
    if (!p || !p.flags) return [];
    const f = p.flags, a = [];
    if (f.absent && f.absent.pct >= 20) a.push("ausência");
    if (f.multiple_people && f.multiple_people.pct >= 20) a.push("+1 pessoa");
    if (f.phone && f.phone.pct >= 25) a.push("celular");
    if (f.hands && f.hands.flag) a.push("mãos fora");
    return a;
}
// Alerta de VOZ: houve pausa longa antes de resposta substancial.
function voiceAlert(v) { return !!(v && v.latency && v.latency.flagged_count > 0); }

// Nota (0–10) calculada da avaliação: correta=1, parcial=0,5, incorreta/não
// respondida=0; média sobre as perguntas FEITAS × 10. Determinística (sem IA).
function gradeFromEval(report) {
    const pq = report && Array.isArray(report.per_question) ? report.per_question : [];
    if (!pq.length) return null;
    const w = { correct: 1, partial: 0.5, incorrect: 0, not_answered: 0 };
    const sum = pq.reduce((acc, q) => acc + (w[q.assessment] != null ? w[q.assessment] : 0), 0);
    return Math.round((sum / pq.length) * 10 * 10) / 10;
}
// Devolutiva-padrão derivada da avaliação (texto legível para o aluno). NÃO inclui
// o gabarito ("expected") por default — o professor pode acrescentar ao editar.
const ASSESS_LABEL = { correct: "correta", partial: "parcial", incorrect: "incorreta", not_answered: "não respondida" };
function devolutivaFromEval(report) {
    if (!report) return "";
    const pq = Array.isArray(report.per_question) ? report.per_question : [];
    const blocks = pq.map((q, i) => {
        const parts = [`${i + 1}. ${q.question}`];
        if (q.student_answer) parts.push(`   Sua resposta: ${q.student_answer}`);
        parts.push(`   Avaliação: ${ASSESS_LABEL[q.assessment] || q.assessment}${q.comment ? " — " + q.comment : ""}`);
        return parts.join("\n");
    });
    return (report.summary ? report.summary + "\n\n" : "") + blocks.join("\n\n");
}
// Após avaliar: preenche devolutiva e nota como DEFAULT (= avaliação), sem
// sobrescrever ajustes já feitos pelo professor. Ambos seguem editáveis.
async function applyEvalDefaults(submissionId, detail, report) {
    if (!detail || !detail.oral_devolutiva || !String(detail.oral_devolutiva).trim()) {
        await db.setOralDevolutiva(submissionId, devolutivaFromEval(report));
    }
    if (!detail || detail.grade_final == null) {
        const g = gradeFromEval(report);
        if (g != null) await db.setOralGrade(submissionId, g);
    }
}

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
            submissions: (subs || []).map(s => ({
                submission_token: s.submission_token,
                student_label: s.student_label,
                status: s.status,
                is_test: !!s.is_test,
                has_oral_video: !!s.has_oral_video,
                has_oral_eval: !!s.has_oral_eval,
                grade: s.grade_final ?? null,
                devolutiva_published: !!s.evaluation_published_at,
                grade_published: !!s.grade_published_at,
                has_oral_proctor: !!s.has_oral_proctor,
                proctor_alerts: proctorAlerts(s.oral_proctor_json),
                voice_alert: voiceAlert(s.oral_voice_json),
            })),
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
        let questions = await oralExamExtractorAgent.extract({
            examFileId: examFile.id,
            meterCtx: { workId: req.work.id },
        });
        // Aspectos de cobertura (tópicos, não respostas) para o examinador checar completude.
        questions = await oralExamAspectsAgent.generate(questions, { workId: req.work.id });
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
        .map(q => ({
            question: String(q?.question || "").trim(),
            answer: String(q?.answer || "").trim(),
            aspects: Array.isArray(q?.aspects) ? q.aspects.map(a => String(a || "").trim()).filter(Boolean).slice(0, 3) : [],
        }))
        .filter(q => q.question)
        .map((q, i) => ({ id: i + 1, ...q }));
    if (cleaned.length === 0) return res.status(400).json({ error: "nenhuma pergunta válida (cada pergunta precisa de enunciado)" });
    try {
        // Auto-gera aspectos só para perguntas com gabarito e ainda sem aspectos (preserva edições).
        let finalQ = cleaned;
        if (cleaned.some(q => q.answer && q.aspects.length === 0)) {
            finalQ = await oralExamAspectsAgent.generate(cleaned, { workId: req.work.id });
        }
        await db.setOralQuestions(req.work.id, finalQ);
        log.info("ORAL", `perguntas manuais salvas work=${req.work.work_token} n=${finalQ.length}`);
        res.json({ ok: true, count: finalQ.length, questions: finalQ });
    } catch (err) {
        log.error("ORAL", `save questions failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar as perguntas" });
    }
});

// --- Avaliação por aluno (professor) — espelha a entrevista, mas a devolutiva
// e a nota são MANUAIS (sem geração por IA). A avaliação compara a transcrição
// das respostas do aluno com o gabarito. ---

router.post("/w/:workToken/oral/submissions/:subToken/evaluate", requireWorkToken, requireProfessorSubmission, requireWithinBudget, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const [asked, detail] = await Promise.all([
            db.getOralAsked(req.submission.id),
            db.getOralSubmissionDetail(req.submission.id),
        ]);
        // Avalia SÓ as perguntas feitas a este aluno (fallback: todas, p/ provas antigas).
        const questions = asked || await db.getOralQuestions(req.work.id);
        const transcript = Array.isArray(detail?.oral_transcript) ? detail.oral_transcript : [];
        if (!questions.length) return res.status(409).json({ error: "a prova não tem gabarito (perguntas)" });
        if (!transcript.length) return res.status(409).json({ error: "sem transcrição — o aluno ainda não realizou a prova" });
        const report = await oralExamEvaluatorAgent.evaluate({
            questions, transcript, meterCtx: { workId: req.work.id, submissionId: req.submission.id },
        });
        await db.setOralEvaluation(req.submission.id, report);
        await applyEvalDefaults(req.submission.id, detail, report); // devolutiva + nota default
        res.json({ ok: true, evaluation: report, grade: gradeFromEval(report) });
    } catch (err) {
        log.error("ORAL", `evaluate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar", detail: err.message });
    }
});

router.get("/w/:workToken/oral/submissions/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const d = await db.getOralSubmissionDetail(req.submission.id);
        res.set("Cache-Control", "no-store");
        res.json({
            student_label: req.submission.student_label,
            completion_reason: d?.completion_reason || null,
            has_oral_video: !!d?.has_oral_video,
            transcript: Array.isArray(d?.oral_transcript) ? d.oral_transcript : [],
            evaluation: d?.oral_eval_json || null,
            devolutiva: d?.oral_devolutiva || "",
            grade: d?.grade_final ?? null,
            devolutiva_published: !!d?.evaluation_published_at,
            grade_published: !!d?.grade_published_at,
            proctor: d?.oral_proctor_json || null,
            voice: d?.oral_voice_json || null,
        });
    } catch (err) { log.error("ORAL", `detail failed: ${err.message}`); res.status(500).json({ error: "falha ao carregar" }); }
});

router.put("/w/:workToken/oral/submissions/:subToken/devolutiva", requireWorkToken, requireProfessorSubmission, express.json({ limit: "64kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try { await db.setOralDevolutiva(req.submission.id, String(req.body?.text ?? "")); res.json({ ok: true }); }
    catch (err) { log.error("ORAL", `devolutiva failed: ${err.message}`); res.status(500).json({ error: "falha ao salvar devolutiva" }); }
});

router.put("/w/:workToken/oral/submissions/:subToken/grade", requireWorkToken, requireProfessorSubmission, express.json({ limit: "8kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const g = req.body?.grade;
    if (g != null && g !== "" && (!Number.isFinite(Number(g)) || Number(g) < 0 || Number(g) > 10)) {
        return res.status(400).json({ error: "nota inválida (0 a 10)" });
    }
    try { await db.setOralGrade(req.submission.id, g == null || g === "" ? null : Number(g)); res.json({ ok: true }); }
    catch (err) { log.error("ORAL", `grade failed: ${err.message}`); res.status(500).json({ error: "falha ao salvar nota" }); }
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
        const key = await db.getOralVideoKey(req.submission.id);
        if (!key) return res.status(409).json({ error: "esta prova não tem vídeo gravado" });
        const report = await analyzeOralVideo(key);
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
        if (!allQuestions.length) return res.status(409).json({ error: "a prova não tem gabarito (perguntas)" });
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
        // Avalia em PARALELO com concorrência limitada: cada avaliação é uma
        // chamada de raciocínio (gpt-5.5) de dezenas de segundos; em série, N
        // alunos = N×esse tempo. Pool de workers reduz o tempo de parede ~Nx,
        // sem disparar todas de uma vez (evita estourar limite de taxa da OpenAI).
        const ORAL_EVAL_CONCURRENCY = 4;
        let next = 0;
        async function evalWorker() {
            while (next < subs.length) {
                const s = subs[next++]; // ++ síncrono: sem corrida no modelo single-thread do JS
                try {
                    const [asked, detail] = await Promise.all([db.getOralAsked(s.id), db.getOralSubmissionDetail(s.id)]);
                    const questions = asked || allQuestions; // só as perguntas feitas a este aluno
                    const transcript = Array.isArray(detail?.oral_transcript) ? detail.oral_transcript : [];
                    if (!transcript.length) {
                        // Item pulado: avisa o cliente p/ tirar a ampulheta dessa linha.
                        send({ type: "item", submission_token: s.submission_token, ok: false, error: "sem transcrição" });
                        continue;
                    }
                    const report = await oralExamEvaluatorAgent.evaluate({
                        questions, transcript, meterCtx: { workId: req.work.id, submissionId: s.id },
                    });
                    await db.setOralEvaluation(s.id, report);
                    await applyEvalDefaults(s.id, detail, report); // devolutiva + nota default
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
            }
        }
        await Promise.all(Array.from({ length: Math.min(ORAL_EVAL_CONCURRENCY, subs.length) }, evalWorker));
        log.info("ORAL", `evaluate-all work=${req.work.work_token} avaliadas=${evaluated}/${subs.length} force=${force} conc=${ORAL_EVAL_CONCURRENCY}`);
        send({ type: "done", evaluated, candidates: subs.length, errors });
        res.end();
    } catch (err) {
        log.error("ORAL", `evaluate-all failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; } // headers já enviados: só encerra
        res.status(500).json({ error: "falha na avaliação em lote", detail: err.message });
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
                const key = await db.getOralVideoKey(s.id);
                if (!key) {
                    // Item pulado: avisa o cliente p/ tirar a ampulheta dessa linha.
                    send({ type: "item", submission_token: s.submission_token, ok: false, error: "sem vídeo" });
                    continue;
                }
                const tv = Date.now();
                const report = await analyzeOralVideo(key);
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
async function mintRealtimeSecret({ instructions, voice }) {
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
        const instructions = buildExamInstructions(sampled, req.work.name);
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

// Status para a página do aluno: já realizou a prova? (teste nunca trava).
router.get("/s/:submissionToken/oral/status", requireSubmissionToken, (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const done = !!req.submission.completion_reason && !req.submission.is_test;
    res.json({ done, is_test: !!req.submission.is_test });
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
        const key = `oral-video/${req.submission.submission_token}.${ext}`;
        const buffer = await fs.promises.readFile(req.file.path); // do temporário em disco
        const r = await putAudio({ key, buffer, mimetype: req.file.mimetype });
        if (!r.stored) {
            log.error("ORAL", `vídeo não armazenado submission=${req.submission.submission_token}: ${r.reason}`);
            return res.status(502).json({ error: "falha ao armazenar o vídeo", detail: r.reason });
        }
        await db.setOralVideoKey(req.submission.id, key);
        log.info("ORAL", `vídeo armazenado submission=${req.submission.submission_token} key=${key} bytes=${buffer.length}`);
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
router.get("/w/:workToken/oral/video/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    try {
        const key = await db.getOralVideoKey(req.submission.id);
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

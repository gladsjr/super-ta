// Rotas do professor (auth via work_token Bearer).
// Inclui também as rotas de templates de entrevistador (compartilhadas) que
// vivem fora do prefixo /w/* mas são consumidas no fluxo de configuração.

import express from "express";
import multer from "multer";
import yaml from "js-yaml";
import OpenAI from "openai";
import { requireWorkToken, requireWithinBudget, sanitizeLabel } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { pickRandomName } from "../lib/personas.js";
import { VOICES, isValidVoice } from "../config/voices.js";
import { AudioCache, synthesizeSpeech } from "../lib/audio.js";
import {
    meteredResponses,
    meteredTts,
    getWorkBalance,
    isWorkBudgetExceeded,
} from "../lib/billing.js";
import { openai } from "../lib/openaiClient.js";
import { configAssistantAgent, enunciadoCoherenceAgent, interviewEvaluatorAgent, studentFeedbackAgent } from "../lib/agents.js";
import { streamAudio } from "../lib/audioStore.js";
import {
    PRINCIPAL_REASONING_MODEL,
    TTS_MODEL,
    isValidQuestionCount,
    MIN_QUESTION_COUNT,
    MAX_QUESTION_COUNT,
} from "../lib/config.js";
import log from "../lib/logger.js";

const router = express.Router();

const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MB
const enunciadoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMIT_BYTES },
});

// ============================================================================
// Info do trabalho
// ============================================================================
router.get("/w/:workToken/info", requireWorkToken, async (req, res) => {
    try {
        const submissions = await db.listSubmissionsForWork(req.work.id);
        const balance = await getWorkBalance(req.work.id);
        // Lista dinâmica que precisa refletir criações/bloqueios na hora. Sem
        // isto, em produção (atrás do Google Frontend) o navegador pode servir
        // uma cópia em cache e o professor não vê o token recém-gerado.
        res.set("Cache-Control", "no-store");
        res.json({
            work: {
                name: req.work.name,
                has_enunciado: !!req.work.assignment_pdf,
                has_interviewer: !!req.work.has_interviewer,
                interaction_mode: req.work.interaction_mode,
                voice: req.work.voice,
                question_count: req.work.question_count,
                interviewer_name: req.work.interviewer_name,
                interviewer_gender: req.work.interviewer_gender,
                budget_usd: balance?.budget_usd ?? 0,
                spent_usd: balance?.spent_usd ?? 0,
                remaining_usd: balance?.remaining_usd ?? 0,
                percent_used: balance?.percent_used ?? 100,
            },
            submissions,
        });
    } catch (err) {
        log.error("WORK", `info failed: ${err.message}`);
        res.status(500).json({ error: "failed to load work info" });
    }
});

// Renomeia o trabalho. Usa sanitizeLabel (mesma validação dos rótulos de
// submissão) — limite 80 chars, sem caracteres proibidos. Autenticação pelo
// próprio work_token: quem tem o token pode renomear.
router.patch("/w/:workToken/name", requireWorkToken, express.json({ limit: "8kb" }), async (req, res) => {
    let name;
    try { name = sanitizeLabel(req.body?.name); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    try {
        await db.renameWork(req.work.id, name);
        log.info("WORK", `renamed work=${req.work.work_token} to="${name}"`);
        res.json({ ok: true, name });
    } catch (err) {
        log.error("WORK", `rename failed: ${err.message}`);
        res.status(500).json({ error: "falha ao renomear" });
    }
});

// ============================================================================
// Modo de interação (texto vs áudio) e voz
// ============================================================================
router.get("/w/:workToken/voices", requireWorkToken, (req, res) => {
    res.json({ voices: VOICES.map(v => ({ id: v.id, label: v.label, gender: v.gender })) });
});

const PREVIEW_DEFAULT_TEXT = "Olá, sou seu entrevistador. Vamos começar?";
const previewCache = new AudioCache(20); // chave: voiceId|textHash

function hashText(s) {
    // Hash leve, suficiente pra chave de cache em memória.
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h);
}

router.post("/w/:workToken/voices/preview", requireWorkToken, requireWithinBudget, express.json({ limit: "16kb" }), async (req, res) => {
    const voiceId = String(req.body?.voiceId ?? "");
    const text = String(req.body?.text ?? PREVIEW_DEFAULT_TEXT).slice(0, 200);
    if (!isValidVoice(voiceId)) return res.status(400).json({ error: "voz inválida" });

    const cacheKey = `${voiceId}|${hashText(text)}`;
    let buffer = previewCache.get(cacheKey);
    if (!buffer) {
        try {
            buffer = await meteredTts(
                { workId: req.work.id, model: TTS_MODEL, inputText: text },
                () => synthesizeSpeech(openai, TTS_MODEL, text, voiceId)
            );
            previewCache.set(cacheKey, buffer);
        } catch (err) {
            log.error("VOICES", `preview failed: ${err.message}`);
            return res.status(500).json({ error: "falha ao gerar prévia", detail: err.message });
        }
    }
    res.type("audio/mpeg");
    res.send(buffer);
});

// Sugestão de nome para o painel do professor — backend mantém as listas
// canônicas (lib/personas.js), frontend só pede uma amostra. Sem requireWorkToken
// porque é puramente uma operação read-only sobre dados literais; gateá-la não
// agrega segurança e simplifica a UI.
router.get("/interviewer-name-suggestion", (req, res) => {
    const requested = req.query.gender === "f" || req.query.gender === "m" ? req.query.gender : null;
    // Sem gênero pedido, sorteia balanceado. NUNCA devolve null: o frontend
    // marca o radio input[value="${gender}"], e só existem 'f' e 'm' — um null
    // viraria querySelector(...).checked sobre null e derrubaria o load().
    const gender = requested ?? (Math.random() < 0.5 ? "f" : "m");
    const name = pickRandomName(gender);
    res.json({ name, gender });
});

router.patch("/w/:workToken/interviewer-identity", requireWorkToken, express.json({ limit: "8kb" }), async (req, res) => {
    const { name, gender } = req.body ?? {};
    const clear = name == null && gender == null;
    const set = typeof name === "string" && name.trim() && (gender === "f" || gender === "m");
    if (!clear && !set) {
        return res.status(400).json({ error: "name e gender devem ser ambos preenchidos (gender 'f' ou 'm') ou ambos nulos" });
    }
    try {
        await db.setWorkInterviewerIdentity(req.work.id, clear ? null : name, clear ? null : gender);
        log.info("WORK", `interviewer identity ${clear ? "cleared" : `set name="${name}" gender=${gender}`} work=${req.work.work_token}`);
        res.json({
            ok: true,
            interviewer_name: clear ? null : name.trim(),
            interviewer_gender: clear ? null : gender,
        });
    } catch (err) {
        log.error("WORK", `set interviewer identity failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar identidade", detail: err.message });
    }
});

router.post("/w/:workToken/interaction", requireWorkToken, express.json({ limit: "16kb" }), async (req, res) => {
    const mode = String(req.body?.mode ?? "");
    const voice = req.body?.voice ? String(req.body.voice) : null;

    if (mode !== "text" && mode !== "audio") {
        return res.status(400).json({ error: "mode deve ser 'text' ou 'audio'" });
    }
    if (mode === "audio" && !isValidVoice(voice)) {
        return res.status(400).json({ error: "voz inválida ou ausente para o modo áudio" });
    }

    try {
        await db.setInteractionMode(req.work.id, mode, voice);
        log.info("WORK", `interaction mode=${mode} voice=${voice ?? "-"} work=${req.work.work_token}`);
        res.json({ ok: true, interaction_mode: mode, voice: mode === "audio" ? voice : null });
    } catch (err) {
        log.error("WORK", `set interaction failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar modo de interação", detail: err.message });
    }
});

// Número de perguntas planejadas da entrevista. Vale para novas submissões — o
// valor é materializado no plano (PrepBuilder.buildPlan) no /upload do aluno.
router.post("/w/:workToken/question-count", requireWorkToken, express.json({ limit: "8kb" }), async (req, res) => {
    const count = Number(req.body?.question_count);
    if (!isValidQuestionCount(count)) {
        return res.status(400).json({ error: `número de perguntas deve ser um inteiro entre ${MIN_QUESTION_COUNT} e ${MAX_QUESTION_COUNT}` });
    }
    try {
        await db.setQuestionCount(req.work.id, count);
        log.info("WORK", `question_count=${count} work=${req.work.work_token}`);
        res.json({ ok: true, question_count: count });
    } catch (err) {
        log.error("WORK", `set question_count failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar número de perguntas", detail: err.message });
    }
});

// ============================================================================
// Visualização da conversa pelo professor
// ============================================================================
router.get("/w/:workToken/submissions/:subToken/conversation", requireWorkToken, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const [text, runtime, finalization] = await Promise.all([
            db.getConversationJson(found.id),
            db.getSubmissionRuntimeState(found.id),
            db.getSubmissionFinalization(found.id),
        ]);
        let conversation = null;
        if (text) {
            try { conversation = JSON.parse(text); }
            catch (err) {
                log.error("WORK", `conversation parse failed submission=${subToken}: ${err.message}`);
                return res.status(500).json({ error: "failed to read conversation" });
            }
        }
        // Acrescenta as perguntas planejadas que ainda não foram feitas. O plano
        // original vive em runtime_state.interview_plan; o cursor question_index
        // aponta para a próxima a considerar (tanto perguntas feitas quanto
        // puladas avançam o cursor). Skipped ficam abaixo do cursor — já são
        // expostos por outra seção. Slice(cursor) é exatamente o "futuro".
        const planQuestions = runtime?.runtime_state?.interview_plan?.questions;
        if (conversation && Array.isArray(planQuestions)) {
            const cursor = typeof runtime.question_index === "number" ? runtime.question_index : 0;
            conversation.pending_questions = planQuestions.slice(cursor).map((q, i) => ({
                index: cursor + i,
                id: q?.id ?? null,
                question: q?.question ?? "",
                rationale: q?.rationale ?? "",
                objectives: q?.objectives ?? [],
                concerns: q?.concerns ?? [],
                decision_criteria: q?.decision_criteria ?? [],
                information_needs: q?.information_needs ?? [],
                evaluation_mode: q?.evaluation_mode ?? [],
            }));
        }
        if (conversation && finalization?.completion_reason) {
            // completion_reason/completed_at/student_comment vêm da linha da
            // submission (fonte autoritativa). message/finalize_reason vêm do
            // conversation_json (despedida durável, B) — preserva antes do overwrite.
            const closingMessage = typeof conversation.finalization?.message === "string"
                ? conversation.finalization.message : null;
            const finalizeReason = conversation.finalization?.finalize_reason ?? null;
            conversation.finalization = {
                completion_reason: finalization.completion_reason,
                completed_at: finalization.completed_at,
                student_comment: finalization.student_comment,
                message: closingMessage,
                finalize_reason: finalizeReason,
            };
        }
        // Lista das gravações de áudio do aluno (modo áudio). Cada item tem
        // audio_idx — a ordem bate com a ordem dos uploads de áudio, e por
        // construção do /chat handler bate com a ordem das falas do aluno em
        // conv_chat. A UI casa um pelo outro contando user-messages.
        try {
            const artifacts = await db.listStudentAudioArtifactsForSubmission(found.id);
            if (conversation && artifacts.length > 0) {
                conversation.student_audio = artifacts.map(a => ({
                    audio_idx: a.audio_idx,
                    mimetype: a.mimetype,
                    duration_s: a.duration_s ? Number(a.duration_s) : null,
                    byte_size: a.byte_size,
                    audio_url: `/w/${encodeURIComponent(req.work.work_token)}/submissions/${encodeURIComponent(subToken)}/audio/${a.audio_idx}`,
                }));
            }
        } catch (err) {
            log.error("WORK", `audio list failed submission=${subToken}: ${err.message}`);
        }
        res.json({
            work: { work_token: req.work.work_token, name: req.work.name },
            submission: { submission_token: subToken, student_label: found.student_label, status: found.status },
            conversation,
        });
    } catch (err) {
        log.error("WORK", `conversation lookup failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to read conversation" });
    }
});

// Streama o áudio gravado do aluno. Acesso restrito ao professor do work
// (requireWorkToken garante isso). Object Storage indisponível ou objeto
// inexistente → 404.
router.get("/w/:workToken/submissions/:subToken/audio/:audioIdx", requireWorkToken, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    const audioIdx = Number.parseInt(req.params.audioIdx, 10);
    if (!Number.isFinite(audioIdx) || audioIdx < 0) {
        return res.status(400).json({ error: "audio_idx inválido" });
    }
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const artifact = await db.getStudentAudioArtifact({ submissionId: found.id, audioIdx });
        if (!artifact) return res.status(404).json({ error: "audio not found" });
        const stream = await streamAudio(artifact.object_key);
        if (!stream) return res.status(503).json({ error: "audio store unavailable" });
        if (artifact.mimetype) res.type(artifact.mimetype);
        stream.on("error", err => {
            log.error("WORK", `stream error key=${artifact.object_key}: ${err.message}`);
            if (!res.headersSent) res.status(404).json({ error: "audio not found in store" });
            else res.end();
        });
        stream.pipe(res);
    } catch (err) {
        log.error("WORK", `audio fetch failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to fetch audio" });
    }
});

// ============================================================================
// Avaliação da entrevista sob a perspectiva do entrevistador
// ============================================================================
// Funcionalidade do professor: o InterviewEvaluatorAgent lê enunciado + entrega
// (PDFs) + transcrição (+ metadados de áudio quando houver) e produz um
// relatório estruturado de como o aluno sustentou o trabalho diante da persona.
// Resultado é cacheado em submissions.evaluation_json; ?force=true regenera.
// GET é leitura barata do cache (a página da conversa consulta no load).

router.get("/w/:workToken/submissions/:subToken/evaluation", requireWorkToken, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const [cached, student] = await Promise.all([
            db.getEvaluationCache(found.id),
            db.getStudentEvaluation(found.id),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            evaluation: cached?.report ?? null,
            evaluated_at: cached?.evaluated_at ?? null,
            student_evaluation: student?.report ?? null,
            student_evaluation_at: student?.generated_at ?? null,
            published_at: student?.published_at ?? null,
        });
    } catch (err) {
        log.error("EVALUATION", `read failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to read evaluation" });
    }
});

// Avalia UMA submissão (compartilhada entre a rota individual e o lote).
// Erros "esperados" (entrevista sem respostas, insumos ausentes) saem com
// err.notReady=true e err.httpStatus — o lote os trata como "pulada".
async function evaluateSubmissionNow(work, found, { force }) {
    const subToken = found.submission_token;
    if (!force) {
        const cached = await db.getEvaluationCache(found.id);
        if (cached) {
            log.info("EVALUATION", `cache hit submission=${subToken}`);
            return { evaluation: cached.report, evaluated_at: cached.evaluated_at, cached: true };
        }
    }

    const notReady = (msg, httpStatus) => Object.assign(new Error(msg), { notReady: true, httpStatus });

    const conversationText = await db.getConversationJson(found.id);
    if (!conversationText) throw notReady("a entrevista ainda não começou — nada para avaliar", 409);
    let conversation;
    try { conversation = JSON.parse(conversationText); }
    catch (err) {
        log.error("EVALUATION", `conversation parse failed submission=${subToken}: ${err.message}`);
        throw new Error("failed to read conversation");
    }
    const answeredTurns = (Array.isArray(conversation.turns) ? conversation.turns : [])
        .filter(t => typeof t?.answer === "string" && t.answer.trim());
    if (answeredTurns.length === 0) throw notReady("a entrevista ainda não tem respostas — nada para avaliar", 409);

    const [enunciadoBlob, studentBlob, interviewerYamlText] = await Promise.all([
        db.getEnunciadoBlob(work.id),
        db.getStudentPdfBlob(found.id),
        db.getInterviewerYaml(work.id),
    ]);
    if (!enunciadoBlob) throw notReady("enunciado ausente — não dá para avaliar", 400);
    if (!studentBlob) throw notReady("trabalho do aluno ausente — não dá para avaliar", 400);
    if (!interviewerYamlText) throw notReady("entrevistador não configurado — não dá para avaliar", 400);

    let audioArtifacts = [];
    try {
        audioArtifacts = await db.listStudentAudioArtifactsForSubmission(found.id);
    } catch (err) {
        log.error("EVALUATION", `audio list failed submission=${subToken}: ${err.message}`);
    }

    log.info("EVALUATION", `start submission=${subToken} turns=${answeredTurns.length} audio=${audioArtifacts.length} force=${force}`);
    const [enunciadoUpload, studentUpload] = await Promise.all([
        openai.files.create({
            file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
            purpose: "user_data",
        }),
        openai.files.create({
            file: await OpenAI.toFile(studentBlob.pdf, studentBlob.filename || "trabalho.pdf"),
            purpose: "user_data",
        }),
    ]);
    log.info("EVALUATION", `uploaded files enunciado=${enunciadoUpload.id} trabalho=${studentUpload.id}`);

    const report = await interviewEvaluatorAgent.evaluate({
        enunciadoFileId: enunciadoUpload.id,
        studentFileId: studentUpload.id,
        interviewerYamlText,
        conversation,
        audioArtifacts,
        meterCtx: { workId: work.id },
    });
    const evaluatedAt = await db.setEvaluationCache(found.id, report);
    log.info("EVALUATION", `ok submission=${subToken} defense=${report.overall.defense_quality}`);
    return { evaluation: report, evaluated_at: evaluatedAt, cached: false };
}

router.post("/w/:workToken/submissions/:subToken/evaluation", requireWorkToken, requireWithinBudget, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    const force = String(req.query?.force ?? "").toLowerCase() === "true";
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const result = await evaluateSubmissionNow(req.work, found, { force });
        res.json(result);
    } catch (err) {
        if (err.notReady) return res.status(err.httpStatus ?? 409).json({ error: err.message });
        log.error("EVALUATION", `failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar a entrevista", detail: err.message });
    }
});

// ---- Publicação da devolutiva ao aluno ----
// A avaliação interna NUNCA vai crua ao aluno: publicar = derivar (e cachear)
// a versão formativa via StudentFeedbackAgent + marcar evaluation_published_at.
// force=true regenera a versão do aluno mesmo se já existir.
async function publishSubmissionNow(work, found, { force }) {
    const subToken = found.submission_token;
    const internal = await db.getEvaluationCache(found.id);
    if (!internal) {
        throw Object.assign(
            new Error("não há avaliação do entrevistador para esta submissão — avalie antes de publicar"),
            { notReady: true, httpStatus: 409 }
        );
    }
    let student = force ? null : await db.getStudentEvaluation(found.id);
    let generated = false;
    if (!student) {
        log.info("PUBLISH", `derive student feedback submission=${subToken} force=${force}`);
        const report = await studentFeedbackAgent.derive({
            internalReport: internal.report,
            meterCtx: { workId: work.id },
        });
        const generatedAt = await db.setStudentEvaluation(found.id, report);
        student = { report, generated_at: generatedAt, published_at: null };
        generated = true;
    }
    const publishedAt = await db.setEvaluationPublished(found.id, true);
    log.info("PUBLISH", `published submission=${subToken} generated=${generated}`);
    return {
        student_evaluation: student.report,
        student_evaluation_at: student.generated_at,
        published_at: publishedAt,
        generated,
    };
}

router.post("/w/:workToken/submissions/:subToken/evaluation/publish", requireWorkToken, requireWithinBudget, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    const force = String(req.query?.force ?? "").toLowerCase() === "true";
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const result = await publishSubmissionNow(req.work, found, { force });
        res.json(result);
    } catch (err) {
        if (err.notReady) return res.status(err.httpStatus ?? 409).json({ error: err.message });
        log.error("PUBLISH", `failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao publicar a devolutiva", detail: err.message });
    }
});

// Despublica (a versão do aluno fica guardada; republicar não regenera).
router.delete("/w/:workToken/submissions/:subToken/evaluation/publish", requireWorkToken, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        await db.setEvaluationPublished(found.id, false);
        log.info("PUBLISH", `unpublished submission=${subToken}`);
        res.json({ ok: true, published_at: null });
    } catch (err) {
        log.error("PUBLISH", `unpublish failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao despublicar a devolutiva" });
    }
});

// ---- Avaliação em LOTE (todas as submissões do trabalho) ----
// Roda em background, SERIAL (uma submissão por vez): mantém a carga na API
// previsível e permite checar o orçamento entre itens. Estado em memória por
// work — sobrevive só enquanto o processo vive; se o servidor reiniciar no
// meio, basta disparar de novo (com force=false o cache pula as já feitas).
const batchEvalRuns = new Map(); // work.id -> estado

function publicBatchState(state) {
    if (!state) return null;
    return {
        running: state.running,
        force: state.force,
        total: state.total,
        done: state.done,
        ok: state.ok,
        skipped: state.skipped,
        failed: state.failed,
        stopped_reason: state.stopped_reason,
        started_at: state.started_at,
        finished_at: state.finished_at,
    };
}

async function runBatchEvaluation(work, queue, state) {
    log.info("EVALUATION", `batch start work=${work.work_token} total=${queue.length} force=${state.force}`);
    for (const sub of queue) {
        // Orçamento re-checado a cada item: o lote para no meio se esgotar.
        try {
            if (await isWorkBudgetExceeded(work.id)) {
                state.stopped_reason = "budget_exhausted";
                log.warn("EVALUATION", `batch interrompido por orçamento work=${work.work_token} done=${state.done}/${state.total}`);
                break;
            }
            const found = await db.findSubmissionByToken(sub.submission_token);
            if (!found || found.work_id !== work.id) { state.skipped++; continue; }
            const r = await evaluateSubmissionNow(work, found, { force: state.force });
            if (r.cached) state.skipped++;
            else state.ok++;
        } catch (err) {
            if (err.notReady) {
                state.skipped++;
            } else {
                state.failed.push({ submission_token: sub.submission_token, student_label: sub.student_label, error: err.message });
                log.error("EVALUATION", `batch item failed submission=${sub.submission_token}: ${err.message}`);
            }
        } finally {
            state.done++;
        }
    }
    state.running = false;
    state.finished_at = new Date().toISOString();
    log.info("EVALUATION", `batch done work=${work.work_token} ok=${state.ok} skipped=${state.skipped} failed=${state.failed.length} stopped=${state.stopped_reason ?? "-"}`);
}

router.post("/w/:workToken/evaluations", requireWorkToken, requireWithinBudget, express.json({ limit: "8kb" }), async (req, res) => {
    const force = req.body?.force === true;
    try {
        const existing = batchEvalRuns.get(req.work.id);
        if (existing?.running || batchPublishRuns.get(req.work.id)?.running) {
            return res.status(409).json({ error: "já existe um lote em andamento para este trabalho", batch: publicBatchState(existing) });
        }
        const subs = await db.listSubmissionsForWork(req.work.id);
        // Candidatas: têm conversa (status derivado != pending). A elegibilidade
        // fina (tem resposta? insumos presentes?) é decidida item a item no
        // loop — itens não-prontos contam como "puladas", não como erro.
        const queue = subs.filter(s => s.status !== "pending" && (force || !s.has_evaluation));
        if (queue.length === 0) {
            return res.status(400).json({
                error: force
                    ? "nenhuma entrevista com conversa para avaliar"
                    : "nenhuma entrevista nova para avaliar — todas as elegíveis já têm avaliação",
            });
        }
        const state = {
            running: true,
            force,
            total: queue.length,
            done: 0,
            ok: 0,
            skipped: 0,
            failed: [],
            stopped_reason: null,
            started_at: new Date().toISOString(),
            finished_at: null,
        };
        batchEvalRuns.set(req.work.id, state);
        runBatchEvaluation(req.work, queue, state).catch(err => {
            log.error("EVALUATION", `batch crashed work=${req.work.work_token}: ${err.message}`);
            state.running = false;
            state.finished_at = new Date().toISOString();
            state.stopped_reason = "internal_error";
        });
        res.json({ started: true, total: queue.length, force });
    } catch (err) {
        log.error("EVALUATION", `batch start failed: ${err.message}`);
        res.status(500).json({ error: "falha ao iniciar a avaliação em lote", detail: err.message });
    }
});

// ---- Publicação em LOTE das devolutivas ----
// Mesmo padrão do lote de avaliação: serial, em background, estado em memória.
// Elegíveis: submissões COM avaliação interna; sem force, pula as já
// publicadas. force=true regenera a versão do aluno e republica todas.
const batchPublishRuns = new Map(); // work.id -> estado

async function runBatchPublish(work, queue, state) {
    log.info("PUBLISH", `batch start work=${work.work_token} total=${queue.length} force=${state.force}`);
    for (const sub of queue) {
        try {
            if (await isWorkBudgetExceeded(work.id)) {
                state.stopped_reason = "budget_exhausted";
                log.warn("PUBLISH", `batch interrompido por orçamento work=${work.work_token} done=${state.done}/${state.total}`);
                break;
            }
            const found = await db.findSubmissionByToken(sub.submission_token);
            if (!found || found.work_id !== work.id) { state.skipped++; continue; }
            await publishSubmissionNow(work, found, { force: state.force });
            state.ok++;
        } catch (err) {
            if (err.notReady) {
                state.skipped++;
            } else {
                state.failed.push({ submission_token: sub.submission_token, student_label: sub.student_label, error: err.message });
                log.error("PUBLISH", `batch item failed submission=${sub.submission_token}: ${err.message}`);
            }
        } finally {
            state.done++;
        }
    }
    state.running = false;
    state.finished_at = new Date().toISOString();
    log.info("PUBLISH", `batch done work=${work.work_token} ok=${state.ok} skipped=${state.skipped} failed=${state.failed.length} stopped=${state.stopped_reason ?? "-"}`);
}

router.post("/w/:workToken/evaluations/publish", requireWorkToken, requireWithinBudget, express.json({ limit: "8kb" }), async (req, res) => {
    const force = req.body?.force === true;
    try {
        const runningEval = batchEvalRuns.get(req.work.id);
        const runningPub = batchPublishRuns.get(req.work.id);
        if (runningEval?.running || runningPub?.running) {
            return res.status(409).json({ error: "já existe um lote em andamento para este trabalho" });
        }
        const subs = await db.listSubmissionsForWork(req.work.id);
        const queue = subs.filter(s => s.has_evaluation && (force || !s.evaluation_published_at));
        if (queue.length === 0) {
            return res.status(400).json({
                error: force
                    ? "nenhuma submissão com avaliação para publicar — avalie as entrevistas antes"
                    : "nenhuma devolutiva nova para publicar — todas as avaliadas já estão publicadas",
            });
        }
        const state = {
            running: true,
            force,
            total: queue.length,
            done: 0,
            ok: 0,
            skipped: 0,
            failed: [],
            stopped_reason: null,
            started_at: new Date().toISOString(),
            finished_at: null,
        };
        batchPublishRuns.set(req.work.id, state);
        runBatchPublish(req.work, queue, state).catch(err => {
            log.error("PUBLISH", `batch crashed work=${req.work.work_token}: ${err.message}`);
            state.running = false;
            state.finished_at = new Date().toISOString();
            state.stopped_reason = "internal_error";
        });
        res.json({ started: true, total: queue.length, force });
    } catch (err) {
        log.error("PUBLISH", `batch start failed: ${err.message}`);
        res.status(500).json({ error: "falha ao iniciar a publicação em lote", detail: err.message });
    }
});

router.get("/w/:workToken/evaluations/status", requireWorkToken, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
        batch: publicBatchState(batchEvalRuns.get(req.work.id)),
        publish: publicBatchState(batchPublishRuns.get(req.work.id)),
    });
});

// ============================================================================
// Templates de entrevistador (compartilhados — fora do prefixo /w/*)
// ============================================================================
router.get("/interviewers/templates", async (_req, res) => {
    try {
        const templates = await db.listInterviewerTemplates();
        res.json({ templates });
    } catch (err) {
        log.error("TPL", `list failed: ${err.message}`);
        res.status(500).json({ error: "failed to list templates" });
    }
});

router.get("/interviewers/templates/:filename", async (req, res) => {
    const filename = String(req.params.filename);
    try {
        const content = await db.getInterviewerTemplate(filename);
        if (content == null) return res.status(404).json({ error: "template not found" });
        res.type("text/plain").send(content);
    } catch (err) {
        log.error("TPL", `read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read template" });
    }
});

// ============================================================================
// YAML do entrevistador por trabalho
// ============================================================================
router.get("/w/:workToken/interviewer", requireWorkToken, async (req, res) => {
    try {
        const yamlText = await db.getInterviewerYaml(req.work.id);
        res.json({ yaml: yamlText ?? null });
    } catch (err) {
        log.error("WORK", `interviewer read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read interviewer" });
    }
});

router.post("/w/:workToken/interviewer", requireWorkToken, express.json({ limit: "256kb" }), async (req, res) => {
    const content = String(req.body?.yaml ?? "");
    if (!content.trim()) return res.status(400).json({ error: "yaml content required" });
    try {
        yaml.load(content);
    } catch (err) {
        return res.status(400).json({ error: "invalid YAML", detail: err.message });
    }
    try {
        await db.setInterviewerYaml(req.work.id, content);
        log.info("WORK", `interviewer saved work=${req.work.work_token} bytes=${content.length}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("WORK", `interviewer save failed: ${err.message}`);
        res.status(500).json({ error: "failed to save interviewer" });
    }
});

const INTERVIEWER_ADAPT_INSTRUCTIONS = `Você adapta prompts de entrevistador acadêmico. Receberá:
1) Um YAML com a definição genérica de um entrevistador (agente, cenário, conversa).
2) O enunciado de um trabalho específico, em PDF anexado.

Produza um NOVO YAML que preserve exatamente a mesma estrutura de chaves
e hierarquia do genérico, mas com valores textuais especializados ao trabalho
descrito no enunciado. Os valores passam a referenciar conceitos, termos,
objetivos, métodos e entregáveis concretos do enunciado.

Regras rígidas:
- NÃO invente informações ausentes do enunciado.
- NÃO adicione, remova ou renomeie chaves.
- Mantenha o idioma do YAML genérico.
- Listas mantêm aproximadamente o mesmo número de itens; reescreva cada
  item para soar específico ao trabalho.
- Onde o YAML genérico usar expressões abstratas ("o trabalho", "o aluno
  deve"), substitua por formulações ancoradas no enunciado.
- Campos inerentemente genéricos (ex.: interaction_style com item
  "investigativo") podem ser mantidos se não houver base no enunciado para
  especializá-los.
- O campo scenario.case_context.summary deve descrever, em 1–2 frases, o
  caso concreto entregue pelo aluno conforme o enunciado.

Responda APENAS com o YAML adaptado. Nada antes, nada depois. Sem cercas
de código markdown.`;

function stripYamlFence(text) {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```\s*$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

router.post("/w/:workToken/interviewer/adapt", requireWorkToken, requireWithinBudget, express.json({ limit: "256kb" }), async (req, res) => {
    const genericYaml = String(req.body?.yaml ?? "");
    if (!genericYaml.trim()) return res.status(400).json({ error: "yaml content required" });
    try {
        yaml.load(genericYaml);
    } catch (err) {
        return res.status(400).json({ error: "invalid input YAML", detail: err.message });
    }

    const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
    if (!enunciadoBlob) {
        return res.status(400).json({ error: "envie o enunciado do trabalho antes de adaptar" });
    }

    try {
        log.info("INTERVIEWER_ADAPT", `start work=${req.work.work_token} bytes=${genericYaml.length}`);
        const fileUpload = await openai.files.create({
            file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
            purpose: "user_data",
        });
        log.info("INTERVIEWER_ADAPT", `uploaded enunciado file=${fileUpload.id}`);

        const response = await log.span("INTERVIEWER_ADAPT", "responses.create", () =>
            meteredResponses(
                { workId: req.work.id, agentLabel: "INTERVIEWER_ADAPT", model: PRINCIPAL_REASONING_MODEL },
                () => openai.responses.create({
                    model: PRINCIPAL_REASONING_MODEL,
                    instructions: INTERVIEWER_ADAPT_INSTRUCTIONS,
                    input: [{
                        role: "user",
                        content: [
                            { type: "input_text", text: `YAML genérico:\n\n${genericYaml}\n\nEnunciado em anexo. Gere o YAML adaptado.` },
                            { type: "input_file", file_id: fileUpload.id },
                        ],
                    }],
                })
            )
        );

        const adaptedYaml = stripYamlFence(response.output_text || "");
        if (!adaptedYaml) {
            return res.status(502).json({ error: "o modelo não retornou YAML" });
        }
        try {
            yaml.load(adaptedYaml);
        } catch (err) {
            log.warn("INTERVIEWER_ADAPT", `returned YAML did not parse: ${err.message}`);
            return res.status(502).json({ error: "o modelo retornou YAML inválido", yaml: adaptedYaml, detail: err.message });
        }
        log.info("INTERVIEWER_ADAPT", `ok work=${req.work.work_token} out_bytes=${adaptedYaml.length}`);
        res.json({ yaml: adaptedYaml });
    } catch (err) {
        log.error("INTERVIEWER_ADAPT", `failed: ${err.message}`);
        res.status(500).json({ error: "falha ao adaptar o interviewer", detail: err.message });
    }
});

// ============================================================================
// Enunciado
// ============================================================================
router.get("/w/:workToken/enunciado", requireWorkToken, async (req, res) => {
    try {
        const blob = await db.getEnunciadoBlob(req.work.id);
        if (!blob) return res.status(404).json({ error: "enunciado not uploaded" });
        res.type("application/pdf");
        if (blob.filename) {
            res.set("Content-Disposition", `inline; filename="${encodeURIComponent(blob.filename)}"`);
        }
        res.send(blob.pdf);
    } catch (err) {
        log.error("WORK", `enunciado read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read enunciado" });
    }
});

router.post("/w/:workToken/enunciado", requireWorkToken, enunciadoUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    try {
        await db.setEnunciadoBlob(req.work.id, req.file.buffer, req.file.originalname);
        // Cache de coerência fica obsoleto quando o PDF é substituído.
        await db.clearCoherenceCache(req.work.id);
        log.info("WORK", `enunciado uploaded work=${req.work.work_token} bytes=${req.file.size} name=${req.file.originalname}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("WORK", `enunciado save failed: ${err.message}`);
        res.status(500).json({ error: "failed to save enunciado" });
    }
});

// ---- Coerência do enunciado (assistente de configuração) ----
// Avalia se o enunciado está bem encaixado no processo de entrevista.
// NUNCA avalia a qualidade pedagógica/técnica do trabalho em si.
// Resultado é cacheado em works.enunciado_coherence_json até o PDF ser substituído.
router.post("/w/:workToken/enunciado/coherence", requireWorkToken, requireWithinBudget, async (req, res) => {
    const force = String(req.query?.force ?? "").toLowerCase() === "true";

    try {
        if (!force) {
            const cached = await db.getCoherenceCache(req.work.id);
            if (cached) {
                log.info("COHERENCE", `cache hit work=${req.work.work_token}`);
                return res.json({ ...cached, cached: true });
            }
        }

        const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
        if (!enunciadoBlob) {
            return res.status(400).json({ error: "envie o enunciado do trabalho antes de avaliar" });
        }

        log.info("COHERENCE", `start work=${req.work.work_token} force=${force}`);
        const fileUpload = await openai.files.create({
            file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
            purpose: "user_data",
        });
        log.info("COHERENCE", `uploaded enunciado file=${fileUpload.id}`);

        const report = await enunciadoCoherenceAgent.evaluate({
            openaiFileId: fileUpload.id,
            meterCtx: { workId: req.work.id },
        });
        await db.setCoherenceCache(req.work.id, report);
        log.info("COHERENCE", `ok work=${req.work.work_token} overall=${report.overall}`);
        res.json({ ...report, cached: false });
    } catch (err) {
        log.error("COHERENCE", `failed: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar coerência do enunciado", detail: err.message });
    }
});

// ============================================================================
// Chat efêmero do assistente de configuração
// Histórico vem do cliente em cada turno. Sem persistência server-side e sem
// tocar a Conversations API (ver CLAUDE.md). Modelo: fast_model.
// ============================================================================
router.post("/w/:workToken/config-chat", requireWorkToken, requireWithinBudget, express.json({ limit: "256kb" }), async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message required" });

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const history = rawHistory
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-30); // bound por segurança

    try {
        const stateBlock = await buildConfigStateBlock(req.work);
        const result = await configAssistantAgent.evaluate({
            history,
            message,
            stateBlock,
            meterCtx: { workId: req.work.id },
        });
        res.json(result);
    } catch (err) {
        log.error("CONFIG_CHAT", `failed: ${err.message}`);
        res.status(500).json({ error: "falha no assistente de configuração", detail: err.message });
    }
});

async function buildConfigStateBlock(work) {
    const coherence = await db.getCoherenceCache(work.id);
    const interviewerYaml = await db.getInterviewerYaml(work.id);

    let originLine = "nenhum (professor ainda não salvou)";
    if (interviewerYaml) {
        const matchedTemplate = await findMatchingTemplateName(interviewerYaml);
        originLine = matchedTemplate
            ? `salvo (baseado em "${matchedTemplate}")`
            : "salvo (customizado ou adaptado — não corresponde byte-a-byte a nenhuma das 6 personas prontas)";
    }

    const header = `- Nome do trabalho: ${work.name}
- Enunciado enviado: ${work.assignment_pdf ? "sim" : "não"}
- Persona/YAML do entrevistador: ${originLine}
- Templates disponíveis: Teacher Assistant.yaml, Business Owner.yaml, Hiring Manager.yaml, Investor.yaml, Executive Sponsor.yaml, Journalist.yaml`;

    if (!coherence) {
        return `${header}
- Diagnóstico de coerência do enunciado: ainda não avaliado (você pode emitir action.type=request_assignment_check se o professor pedir avaliação)`;
    }

    const findingsBlock = (coherence.findings || []).map(f =>
        `    - ${f.criterion} [${f.status}]: ${f.comment}`
    ).join("\n");
    const personasBlock = (coherence.suggested_personas || []).map(p =>
        `    - ${p.filename} (fit=${p.fit}): ${p.reason}`
    ).join("\n");
    const fixesBlock = (coherence.fix_suggestions || []).map(s => `    - ${s}`).join("\n");

    return `${header}
- Diagnóstico de coerência do enunciado JÁ DISPONÍVEL (NÃO emita request_assignment_check de novo — comente este relatório):
    overall: ${coherence.overall}
    summary: ${coherence.summary}
  Achados por critério:
${findingsBlock || "    (nenhum)"}
  Personas sugeridas:
${personasBlock || "    (nenhuma)"}
  Sugestões de correção do enunciado:
${fixesBlock || "    (nenhuma)"}`;
}

async function findMatchingTemplateName(savedYamlText) {
    // Best-effort: identifica se o YAML salvo é byte-identical a um dos 6 templates.
    // Se não for, devolvemos null (provavelmente foi adaptado ou customizado).
    const templates = await db.listInterviewerTemplates();
    for (const t of templates) {
        const tplText = await db.getInterviewerTemplate(t.filename);
        if (tplText && tplText.trim() === savedYamlText.trim()) return t.filename;
    }
    return null;
}

// ============================================================================
// Criação de submissions
// ============================================================================
// Aceita dois modos:
//   { label, count }   — modo single legado: cria N submissões com labels
//                        derivados do baseLabel (label, label-2, label-3...).
//   { labels: [...] }  — modo lote por nomes: cria uma submissão por linha,
//                        com o nome cru como rótulo. Sanitização linha a linha;
//                        duplicatas são permitidas (token é o ID único).
// Quando `labels` está presente ele vence; `label`/`count` são ignorados.
const BULK_LABEL_CAP = 200;
router.post("/w/:workToken/submissions", requireWorkToken, async (req, res) => {
    const rawLabels = req.body?.labels;
    if (Array.isArray(rawLabels)) {
        const sanitized = [];
        for (let i = 0; i < rawLabels.length; i++) {
            const raw = String(rawLabels[i] ?? "").trim();
            if (!raw) continue; // ignora linhas vazias silenciosamente
            try { sanitized.push(sanitizeLabel(raw)); }
            catch (err) {
                return res.status(400).json({ error: `linha ${i + 1}: ${err.message}` });
            }
        }
        if (sanitized.length === 0) {
            return res.status(400).json({ error: "lista vazia (nenhum nome válido)" });
        }
        if (sanitized.length > BULK_LABEL_CAP) {
            return res.status(400).json({ error: `máximo de ${BULK_LABEL_CAP} nomes por envio` });
        }
        try {
            const rows = await db.createSubmissionsFromLabels(req.work.id, sanitized);
            log.info("SUBMISSION", `created ${rows.length} submission(s) from labels for work=${req.work.work_token}`);
            return res.json({ submissions: rows });
        } catch (err) {
            log.error("SUBMISSION", `create-from-labels failed: ${err.message}`);
            return res.status(500).json({ error: "failed to create submissions" });
        }
    }

    let baseLabel;
    try { baseLabel = sanitizeLabel(req.body?.label); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    const rawCount = Number(req.body?.count ?? 1);
    const count = Number.isFinite(rawCount) && rawCount > 0 && rawCount <= 50 ? Math.floor(rawCount) : 1;

    try {
        const rows = await db.createSubmissions(req.work.id, baseLabel, count);
        log.info("SUBMISSION", `created ${count} submission(s) for work=${req.work.work_token}`);
        res.json({ submissions: rows });
    } catch (err) {
        log.error("SUBMISSION", `create failed: ${err.message}`);
        res.status(500).json({ error: "failed to create submissions" });
    }
});

// Bloqueio/liberação da entrevista. A checagem efetiva acontece em
// requireSubmissionToken (lib/middleware.js) — todos os endpoints /s/:t/*
// passam por lá e devolvem 403 quando is_blocked=true.
router.patch("/w/:workToken/submissions/:subToken", requireWorkToken, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    if (typeof req.body?.is_blocked !== "boolean") {
        return res.status(400).json({ error: "is_blocked (boolean) required" });
    }
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const newValue = await db.setSubmissionBlocked(found.id, req.body.is_blocked);
        log.info("SUBMISSION", `${newValue ? "blocked" : "unblocked"} submission=${subToken} work=${req.work.work_token}`);
        res.json({ submission_token: subToken, is_blocked: newValue });
    } catch (err) {
        log.error("SUBMISSION", `block toggle failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to update submission" });
    }
});

// Export CSV com label + token + URL para o aluno. URL é montada com base no
// Host header — atrás de proxy reverso pode exigir app.set("trust proxy", true)
// no server.js para refletir o host externo.
function csvField(value) {
    const s = String(value ?? "");
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}
router.get("/w/:workToken/submissions.csv", requireWorkToken, async (req, res) => {
    try {
        const rows = await db.listSubmissionsForWork(req.work.id);
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const header = ["student_label", "submission_token", "student_url", "status", "is_blocked"];
        const lines = [header.join(",")];
        for (const r of rows) {
            lines.push([
                csvField(r.student_label),
                csvField(r.submission_token),
                csvField(`${baseUrl}/s/${r.submission_token}`),
                csvField(r.status),
                csvField(r.is_blocked ? "true" : "false"),
            ].join(","));
        }
        const csv = lines.join("\r\n") + "\r\n";
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="submissoes-${req.work.work_token}.csv"`);
        // UTF-8 BOM ajuda o Excel a abrir acentos corretamente.
        res.send("﻿" + csv);
    } catch (err) {
        log.error("WORK", `csv export failed: ${err.message}`);
        res.status(500).json({ error: "failed to export csv" });
    }
});

export default router;

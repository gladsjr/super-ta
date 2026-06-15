// Rotas do professor (auth via work_token Bearer).
// Inclui também as rotas de templates de entrevistador (compartilhadas) que
// vivem fora do prefixo /w/* mas são consumidas no fluxo de configuração.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import yaml from "js-yaml";
import { requireWorkToken, requireProfessorSubmission, requireWithinBudget, sanitizeLabel } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { pickRandomName } from "../lib/personas.js";
import { VOICES, isValidVoice } from "../config/voices.js";
import { personaDisplay, PERSONA_ORDER, PERSONAS } from "../config/personas.js";
import { renderInterviewerAgenda } from "../lib/interviewerAgenda.js";
import { AudioCache, synthesizeSpeech } from "../lib/audio.js";
import {
    meteredResponses,
    meteredTts,
    getWorkBalance,
    isWorkBudgetExceeded,
} from "../lib/billing.js";
import { openai } from "../lib/openaiClient.js";
import { uploadPdf } from "../lib/openaiFiles.js";
import { configAssistantAgent, enunciadoCoherenceAgent, interviewEvaluatorAgent, studentFeedbackAgent } from "../lib/agents.js";
import { validateStudentFeedbackShape, findForbiddenLeaks } from "../agents/StudentFeedbackAgent.js";
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
                expect_spontaneous: req.work.expect_spontaneous,
                feedback_guidelines: req.work.feedback_guidelines,
                include_interviewer_opinion: req.work.include_interviewer_opinion,
                include_strengths: req.work.include_strengths,
                include_improvement_areas: req.work.include_improvement_areas,
                include_study_suggestions: req.work.include_study_suggestions,
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

// Expectativa de "resposta de cabeça" (espontânea). Quando ligada, a persona
// combina a expectativa na abertura e o aluno vê o aviso. Vale para novas
// tentativas (re-sincronizado no /start e /upload do aluno).
router.patch("/w/:workToken/expect-spontaneous", requireWorkToken, express.json({ limit: "8kb" }), async (req, res) => {
    if (typeof req.body?.expect_spontaneous !== "boolean") {
        return res.status(400).json({ error: "expect_spontaneous (boolean) required" });
    }
    try {
        await db.setWorkExpectSpontaneous(req.work.id, req.body.expect_spontaneous);
        log.info("WORK", `expect_spontaneous=${req.body.expect_spontaneous} work=${req.work.work_token}`);
        res.json({ ok: true, expect_spontaneous: req.body.expect_spontaneous });
    } catch (err) {
        log.error("WORK", `set expect_spontaneous failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a expectativa de espontaneidade", detail: err.message });
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
router.get("/w/:workToken/submissions/:subToken/conversation", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
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
                    turn_index: a.turn_index,                 // casa a gravação com o turno (null = intro/sem turno)
                    intervention_index: a.intervention_index,
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
router.get("/w/:workToken/submissions/:subToken/audio/:audioIdx", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    const audioIdx = Number.parseInt(req.params.audioIdx, 10);
    if (!Number.isFinite(audioIdx) || audioIdx < 0) {
        return res.status(400).json({ error: "audio_idx inválido" });
    }
    try {
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

router.get("/w/:workToken/submissions/:subToken/evaluation", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
        const [cached, student] = await Promise.all([
            db.getEvaluationCache(found.id),
            db.getStudentEvaluation(found.id),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            evaluation: cached?.report ?? null,
            evaluated_at: cached?.evaluated_at ?? null,
            feedback_guidelines: req.work.feedback_guidelines,
            ...studentEvaluationPayload(student),
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
        uploadPdf(enunciadoBlob, "enunciado.pdf"),
        uploadPdf(studentBlob, "trabalho.pdf"),
    ]);
    log.info("EVALUATION", `uploaded files enunciado=${enunciadoUpload.id} trabalho=${studentUpload.id}`);

    const report = await interviewEvaluatorAgent.evaluate({
        enunciadoFileId: enunciadoUpload.id,
        studentFileId: studentUpload.id,
        interviewerYamlText,
        conversation,
        audioArtifacts,
        expectSpontaneous: work.expect_spontaneous === true,
        meterCtx: { workId: work.id },
    });
    const evaluatedAt = await db.setEvaluationCache(found.id, report);
    log.info("EVALUATION", `ok submission=${subToken} defense=${report.overall.defense_quality}`);
    return { evaluation: report, evaluated_at: evaluatedAt, cached: false };
}

router.post("/w/:workToken/submissions/:subToken/evaluation", requireWorkToken, requireProfessorSubmission, requireWithinBudget, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    const force = String(req.query?.force ?? "").toLowerCase() === "true";
    try {
        const result = await evaluateSubmissionNow(req.work, found, { force });
        res.json(result);
    } catch (err) {
        if (err.notReady) return res.status(err.httpStatus ?? 409).json({ error: err.message });
        log.error("EVALUATION", `failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar a entrevista", detail: err.message });
    }
});

// Chaves de seção aceitas nos PATCHes (espelha db.FEEDBACK_SECTIONS).
const SECTION_KEYS = ["interviewer_opinion", "strengths", "improvement_areas", "study_suggestions"];

// Configurações de devolutiva do TRABALHO: diretrizes de geração (tom,
// formato, ênfases) e defaults de visibilidade das seções. Valem para os
// lotes (que propagam às submissões tocadas). PATCH parcial. Com
// apply_to_all=true, propaga as flags a TODAS as submissões na hora (sem LLM).
router.patch("/w/:workToken/feedback-settings", requireWorkToken, express.json({ limit: "32kb" }), async (req, res) => {
    const guidelines = req.body?.feedback_guidelines;
    if (guidelines !== null && guidelines !== undefined && typeof guidelines !== "string") {
        return res.status(400).json({ error: "feedback_guidelines deve ser string ou null" });
    }
    // Campo ausente mantém o valor atual do trabalho.
    const sections = {};
    for (const k of SECTION_KEYS) {
        const col = k === "interviewer_opinion" ? "include_interviewer_opinion" : `include_${k}`;
        sections[k] = typeof req.body?.[k] === "boolean" ? req.body[k] : req.work[col];
    }
    const newGuidelines = guidelines === undefined ? req.work.feedback_guidelines : guidelines;
    try {
        const saved = await db.setWorkFeedbackSettings(req.work.id, newGuidelines ?? null, sections);
        if (req.body?.apply_to_all === true) {
            await db.applyWorkSectionsToAllSubmissions(req.work.id);
            log.info("PUBLISH", `feedback sections applied to all submissions work=${req.work.work_token}`);
        }
        log.info("PUBLISH", `feedback settings work=${req.work.work_token} guidelines=${saved.feedback_guidelines ? saved.feedback_guidelines.length + " chars" : "-"} sections=${JSON.stringify(sections)}`);
        res.json({ ok: true, feedback_guidelines: saved.feedback_guidelines, sections });
    } catch (err) {
        log.error("PUBLISH", `feedback settings failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar as configurações de devolutiva" });
    }
});

// ---- Devolutiva ao aluno: gerar (prévia) é SEPARADO de publicar ----
// A avaliação interna NUNCA vai crua ao aluno. O fluxo é: gerar a versão
// formativa (StudentFeedbackAgent) → professor revisa a prévia (e pode
// EDITAR; a automática fica preservada em coluna própria) → publicar.
// Publicar nunca gera: exige versão existente.

// Defaults de visibilidade do trabalho, no formato de db.setSubmissionSections.
function workSectionDefaults(work) {
    return {
        interviewer_opinion: work.include_interviewer_opinion !== false,
        strengths: work.include_strengths !== false,
        improvement_areas: work.include_improvement_areas !== false,
        study_suggestions: work.include_study_suggestions !== false,
    };
}

function studentEvaluationPayload(student) {
    return {
        student_evaluation: student?.report ?? null,            // efetiva: base − seções desligadas + opinião se ligada
        student_evaluation_base: student?.base_report ?? null,  // base sem filtro (para o editor)
        student_evaluation_auto: student?.auto_report ?? null,
        student_evaluation_at: student?.generated_at ?? null,
        student_evaluation_edited: student?.edited_report ?? null,
        student_evaluation_edited_at: student?.edited_at ?? null,
        published_at: student?.published_at ?? null,
        sections: student?.sections ?? null,                    // visibilidade por seção
        section_has: student?.section_has ?? null,              // presença de conteúdo por seção
        // compat
        include_interviewer_opinion: student?.include_interviewer_opinion ?? true,
        has_interviewer_opinion: student?.has_interviewer_opinion ?? false,
    };
}

// Gera a versão AUTOMÁTICA (sem publicar). force=true regenera; a versão
// editada (se houver) não é tocada — ela continua sendo a efetiva até o
// professor restaurar a automática.
// guidelinesOverride: undefined = usa as diretrizes do trabalho (lote);
// string|null = diretriz AD-HOC desta geração (experimento do professor num
// aluno, sem alterar o padrão do trabalho).
async function deriveStudentVersionNow(work, found, { force, guidelinesOverride }) {
    const subToken = found.submission_token;
    const internal = await db.getEvaluationCache(found.id);
    if (!internal) {
        throw Object.assign(
            new Error("não há avaliação do entrevistador para esta submissão — avalie antes de gerar a devolutiva"),
            { notReady: true, httpStatus: 409 }
        );
    }
    const existing = await db.getStudentEvaluation(found.id);
    if (existing?.auto_report && !force) {
        return { ...studentEvaluationPayload(existing), generated: false };
    }
    const guidelines = guidelinesOverride === undefined ? (work.feedback_guidelines ?? null) : guidelinesOverride;
    log.info("PUBLISH", `derive student feedback submission=${subToken} force=${force} guidelines=${guidelines ? "yes" : "no"}${guidelinesOverride !== undefined ? " (ad-hoc)" : ""}`);
    const report = await studentFeedbackAgent.derive({
        internalReport: internal.report,
        guidelines,
        expectSpontaneous: work.expect_spontaneous === true,
        meterCtx: { workId: work.id },
    });
    await db.setStudentEvaluation(found.id, report);
    const student = await db.getStudentEvaluation(found.id);
    return { ...studentEvaluationPayload(student), generated: true };
}

// Publica a versão EFETIVA existente. Nunca gera.
async function publishSubmissionNow(work, found) {
    const student = await db.getStudentEvaluation(found.id);
    if (!student) {
        throw Object.assign(
            new Error("não há devolutiva gerada para esta submissão — gere (e revise) antes de publicar"),
            { notReady: true, httpStatus: 409 }
        );
    }
    const publishedAt = await db.setEvaluationPublished(found.id, true);
    log.info("PUBLISH", `published submission=${found.submission_token} edited=${!!student.edited_report}`);
    return { ...studentEvaluationPayload(student), published_at: publishedAt };
}

// Gera a versão automática (prévia, sem publicar). ?force=true regenera.
// Body opcional { guidelines }: diretriz AD-HOC desta geração (experimento
// num aluno) — NÃO altera o padrão do trabalho. Ausente = usa o padrão.
router.post("/w/:workToken/submissions/:subToken/evaluation/student-version", requireWorkToken, requireProfessorSubmission, requireWithinBudget, express.json({ limit: "32kb" }), async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    const force = String(req.query?.force ?? "").toLowerCase() === "true";
    const hasOverride = req.body && Object.prototype.hasOwnProperty.call(req.body, "guidelines");
    const rawOverride = req.body?.guidelines;
    if (hasOverride && rawOverride !== null && typeof rawOverride !== "string") {
        return res.status(400).json({ error: "guidelines deve ser string ou null" });
    }
    const guidelinesOverride = hasOverride
        ? (typeof rawOverride === "string" && rawOverride.trim() ? rawOverride.trim() : null)
        : undefined;
    try {
        const result = await deriveStudentVersionNow(req.work, found, { force, guidelinesOverride });
        res.json(result);
    } catch (err) {
        if (err.notReady) return res.status(err.httpStatus ?? 409).json({ error: err.message });
        log.error("PUBLISH", `derive failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a devolutiva", detail: err.message });
    }
});

// Salva a versão EDITADA pelo professor. A automática fica preservada.
// Edição é autoridade do professor: vocabulário interno não bloqueia, mas é
// devolvido em `warnings` para a UI avisar.
router.put("/w/:workToken/submissions/:subToken/evaluation/student-version", requireWorkToken, requireProfessorSubmission, express.json({ limit: "256kb" }), async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
        const report = req.body?.report;
        try { validateStudentFeedbackShape(report); }
        catch (err) { return res.status(400).json({ error: `devolutiva inválida: ${err.message}` }); }
        // A opinião do entrevistador NÃO é editável — vem sempre do relatório
        // interno na composição da efetiva. Qualquer cópia enviada é descartada.
        delete report.interviewer_opinion;
        await db.setStudentEvaluationEdited(found.id, report);
        const student = await db.getStudentEvaluation(found.id);
        const warnings = findForbiddenLeaks(report, { expectSpontaneous: req.work.expect_spontaneous === true });
        log.info("PUBLISH", `edited saved submission=${subToken} warnings=${warnings.length}`);
        res.json({ ...studentEvaluationPayload(student), warnings });
    } catch (err) {
        log.error("PUBLISH", `edit save failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a edição", detail: err.message });
    }
});

// Descarta a edição (a automática volta a ser a efetiva).
router.delete("/w/:workToken/submissions/:subToken/evaluation/student-version", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
        await db.setStudentEvaluationEdited(found.id, null);
        const student = await db.getStudentEvaluation(found.id);
        log.info("PUBLISH", `edited discarded submission=${subToken}`);
        res.json(studentEvaluationPayload(student));
    } catch (err) {
        log.error("PUBLISH", `edit discard failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao descartar a edição" });
    }
});

// Liga/desliga a visibilidade de seções da devolutiva DESTE aluno (toggle
// instantâneo, sem regerar). Body: subconjunto de SECTION_KEYS → boolean.
// A opinião do entrevistador é uma dessas seções; o texto não é editável,
// só a inclusão.
router.patch("/w/:workToken/submissions/:subToken/evaluation/sections", requireWorkToken, requireProfessorSubmission, express.json({ limit: "8kb" }), async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    const partial = {};
    for (const k of SECTION_KEYS) {
        if (typeof req.body?.[k] === "boolean") partial[k] = req.body[k];
    }
    if (Object.keys(partial).length === 0) {
        return res.status(400).json({ error: `informe ao menos uma seção (${SECTION_KEYS.join(", ")}) como boolean` });
    }
    try {
        await db.setSubmissionSections(found.id, partial);
        const student = await db.getStudentEvaluation(found.id);
        log.info("PUBLISH", `sections ${JSON.stringify(partial)} submission=${subToken}`);
        res.json(studentEvaluationPayload(student));
    } catch (err) {
        log.error("PUBLISH", `sections toggle failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao atualizar as seções da devolutiva" });
    }
});

router.post("/w/:workToken/submissions/:subToken/evaluation/publish", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
        const result = await publishSubmissionNow(req.work, found);
        res.json(result);
    } catch (err) {
        if (err.notReady) return res.status(err.httpStatus ?? 409).json({ error: err.message });
        log.error("PUBLISH", `failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao publicar a devolutiva", detail: err.message });
    }
});

// Despublica (as versões ficam guardadas; republicar não regenera).
router.delete("/w/:workToken/submissions/:subToken/evaluation/publish", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
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

// A rota de avaliação em lote usa o runner genérico `startBatchRoute` (definido
// adiante). A avaliação custa LLM (checkBudget=true) e mapeia cache-hit ->
// "pulada", igual aos lotes de devolutiva.
router.post("/w/:workToken/evaluations", requireWorkToken, requireWithinBudget, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchEvalRuns,
    scope: "EVALUATION",
    // Candidatas: têm conversa (status derivado != pending). A elegibilidade
    // fina (tem resposta? insumos presentes?) é decidida item a item no runner
    // — itens não-prontos contam como "puladas", não como erro.
    queueFilter: (s, force) => s.status !== "pending" && (force || !s.has_evaluation),
    emptyError: force => force
        ? "nenhuma entrevista com conversa para avaliar"
        : "nenhuma entrevista nova para avaliar — todas as elegíveis já têm avaliação",
    itemFn: async (work, found, force) => {
        const r = await evaluateSubmissionNow(work, found, { force });
        return { skipped: r.cached };
    },
    checkBudget: true,
}));

// ---- Lotes de devolutiva: GERAR (prévias) e PUBLICAR — separados ----
// Mesmo padrão do lote de avaliação: serial, em background, estado em memória.
// Gerar: submissões COM avaliação interna; sem force, pula as que já têm
//   versão automática. Custa LLM por item.
// Publicar: submissões COM versão gerada; sem force, pula as já publicadas.
//   Não custa LLM (só marca a visibilidade) — por isso não derruba o lote
//   por orçamento.
const batchDeriveRuns = new Map();  // work.id -> estado (gerar prévias)
const batchPublishRuns = new Map(); // work.id -> estado (publicar)

function anyBatchRunning(workId) {
    return batchEvalRuns.get(workId)?.running
        || batchDeriveRuns.get(workId)?.running
        || batchPublishRuns.get(workId)?.running;
}

function newBatchState(force, total) {
    return {
        running: true,
        force,
        total,
        done: 0,
        ok: 0,
        skipped: 0,
        failed: [],
        stopped_reason: null,
        started_at: new Date().toISOString(),
        finished_at: null,
    };
}

// Runner genérico dos lotes de devolutiva: itera a fila chamando itemFn por
// submissão. checkBudget=true re-checa o orçamento a cada item (operações
// que custam LLM).
async function runBatchOver(scope, work, queue, state, itemFn, { checkBudget }) {
    log.info(scope, `batch start work=${work.work_token} total=${queue.length} force=${state.force}`);
    for (const sub of queue) {
        try {
            if (checkBudget && await isWorkBudgetExceeded(work.id)) {
                state.stopped_reason = "budget_exhausted";
                log.warn(scope, `batch interrompido por orçamento work=${work.work_token} done=${state.done}/${state.total}`);
                break;
            }
            const found = await db.findSubmissionByToken(sub.submission_token);
            if (!found || found.work_id !== work.id) { state.skipped++; continue; }
            const r = await itemFn(found);
            if (r?.skipped) state.skipped++;
            else state.ok++;
        } catch (err) {
            if (err.notReady) {
                state.skipped++;
            } else {
                state.failed.push({ submission_token: sub.submission_token, student_label: sub.student_label, error: err.message });
                log.error(scope, `batch item failed submission=${sub.submission_token}: ${err.message}`);
            }
        } finally {
            state.done++;
        }
    }
    state.running = false;
    state.finished_at = new Date().toISOString();
    log.info(scope, `batch done work=${work.work_token} ok=${state.ok} skipped=${state.skipped} failed=${state.failed.length} stopped=${state.stopped_reason ?? "-"}`);
}

function startBatchRoute({ map, scope, queueFilter, emptyError, itemFn, checkBudget }) {
    return async (req, res) => {
        const force = req.body?.force === true;
        try {
            if (anyBatchRunning(req.work.id)) {
                return res.status(409).json({ error: "já existe um lote em andamento para este trabalho" });
            }
            const subs = await db.listSubmissionsForWork(req.work.id);
            const queue = subs.filter(s => queueFilter(s, force));
            if (queue.length === 0) {
                return res.status(400).json({ error: emptyError(force) });
            }
            const state = newBatchState(force, queue.length);
            map.set(req.work.id, state);
            runBatchOver(scope, req.work, queue, state, found => itemFn(req.work, found, force), { checkBudget })
                .catch(err => {
                    log.error(scope, `batch crashed work=${req.work.work_token}: ${err.message}`);
                    state.running = false;
                    state.finished_at = new Date().toISOString();
                    state.stopped_reason = "internal_error";
                });
            res.json({ started: true, total: queue.length, force });
        } catch (err) {
            log.error(scope, `batch start failed: ${err.message}`);
            res.status(500).json({ error: "falha ao iniciar o lote", detail: err.message });
        }
    };
}

router.post("/w/:workToken/evaluations/student-versions", requireWorkToken, requireWithinBudget, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchDeriveRuns,
    scope: "PUBLISH",
    queueFilter: (s, force) => s.has_evaluation && (force || !s.has_student_version),
    emptyError: force => force
        ? "nenhuma submissão com avaliação — avalie as entrevistas antes de gerar devolutivas"
        : "nenhuma devolutiva nova para gerar — todas as avaliadas já têm versão do aluno",
    itemFn: async (work, found, force) => {
        // O lote aplica os defaults de visibilidade do trabalho (opinião e
        // seções) a todas as submissões tocadas; ajuste fino por aluno vem
        // depois, na página da conversa.
        await db.setSubmissionSections(found.id, workSectionDefaults(work));
        const r = await deriveStudentVersionNow(work, found, { force });
        return { skipped: !r.generated };
    },
    checkBudget: true,
}));

router.post("/w/:workToken/evaluations/publish", requireWorkToken, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchPublishRuns,
    scope: "PUBLISH",
    queueFilter: (s, force) => s.has_student_version && (force || !s.evaluation_published_at),
    emptyError: force => force
        ? "nenhuma devolutiva gerada para publicar — gere as versões do aluno antes"
        : "nenhuma devolutiva nova para publicar — todas as geradas já estão publicadas",
    itemFn: async (work, found) => {
        await db.setSubmissionSections(found.id, workSectionDefaults(work));
        await publishSubmissionNow(work, found);
        return { skipped: false };
    },
    checkBudget: false,
}));

router.get("/w/:workToken/evaluations/status", requireWorkToken, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
        batch: publicBatchState(batchEvalRuns.get(req.work.id)),
        derive: publicBatchState(batchDeriveRuns.get(req.work.id)),
        publish: publicBatchState(batchPublishRuns.get(req.work.id)),
    });
});

// ============================================================================
// Templates de entrevistador (compartilhados — fora do prefixo /w/*)
// ============================================================================
router.get("/interviewers/templates", async (_req, res) => {
    try {
        const templates = await db.listInterviewerTemplates();
        // Enriquece cada template com a meta amigável do catálogo (config/personas.js)
        // e ordena pela ordem canônica do catálogo — desconhecidos ao fim, alfabético.
        const enriched = templates
            .map(t => {
                const meta = personaDisplay(t.filename);
                return {
                    filename: t.filename,
                    label: meta.label,
                    icon: meta.icon,
                    summary: meta.summary,
                    when_to_use: meta.when_to_use,
                };
            })
            .sort((a, b) => {
                const ai = PERSONA_ORDER.has(a.filename) ? PERSONA_ORDER.get(a.filename) : 999;
                const bi = PERSONA_ORDER.has(b.filename) ? PERSONA_ORDER.get(b.filename) : 999;
                return ai !== bi ? ai - bi : a.filename.localeCompare(b.filename);
            });
        res.json({ templates: enriched });
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
        // `matched` = filename da persona pronta que o YAML salvo reproduz
        // byte-a-byte, ou null se for customizado/adaptado. A galeria do modo
        // Simples usa isso para marcar o cartão ativo.
        const matched = yamlText ? await findMatchingTemplateName(yamlText) : null;
        res.json({ yaml: yamlText ?? null, matched });
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

// Instruções do adaptador de entrevistador. Prompt longo: vive em
// config/interviewer_adapt_instructions.txt (ver "Mapa de prompts" no CLAUDE.md
// e docs/architecture.md), carregado uma vez.
const INTERVIEWER_ADAPT_INSTRUCTIONS = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "interviewer_adapt_instructions.txt"),
    "utf8"
);

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
        const fileUpload = await uploadPdf(enunciadoBlob, "enunciado.pdf");
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
        const fileUpload = await uploadPdf(enunciadoBlob, "enunciado.pdf");
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

    // Rascunho do construtor guiado, carregado pelo cliente (efêmero). Aceita só objeto.
    const draft = (req.body?.draft && typeof req.body.draft === "object" && !Array.isArray(req.body.draft))
        ? req.body.draft
        : null;

    try {
        const stateBlock = await buildConfigStateBlock(req.work);
        const result = await configAssistantAgent.evaluate({
            history,
            message,
            stateBlock,
            draft,
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

    let originLine = "nenhum (professor ainda não escolheu/definiu um entrevistador)";
    let agendaBlock = "";
    if (interviewerYaml) {
        const matchedTemplate = await findMatchingTemplateName(interviewerYaml);
        if (matchedTemplate) {
            const meta = personaDisplay(matchedTemplate);
            originLine = `persona pronta "${meta.label}" (${matchedTemplate}), sem adaptações`;
        } else {
            originLine = "configuração personalizada (adaptada ao enunciado ou editada à mão — não corresponde a nenhuma das personas prontas)";
        }
        // Agenda renderizada: significado + valores atuais. NUNCA YAML cru (CLAUDE.md).
        try {
            agendaBlock = `\n\n**PERFIL DO ENTREVISTADOR ATUALMENTE CONFIGURADO** (cada campo já vem com seu significado; use para explicar e para adaptar)\n${renderInterviewerAgenda(interviewerYaml)}`;
        } catch (err) {
            log.warn("CONFIG_CHAT", `renderInterviewerAgenda failed: ${err.message}`);
            agendaBlock = "\n\n**PERFIL DO ENTREVISTADOR ATUALMENTE CONFIGURADO**: há um entrevistador salvo, mas não consegui interpretá-lo (provável erro de formatação).";
        }
    }

    const personasList = PERSONAS.map(p => `${p.label} (${p.filename})`).join(", ");
    const header = `- Nome do trabalho: ${work.name}
- Enunciado enviado: ${work.assignment_pdf ? "sim" : "não"}
- Entrevistador configurado: ${originLine}
- Personas prontas disponíveis: ${personasList}${agendaBlock}`;

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
    // Marcação de teste é definida na criação (decisão de produto: não muda depois).
    const isTest = req.body?.is_test === true;
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
            const rows = await db.createSubmissionsFromLabels(req.work.id, sanitized, isTest);
            log.info("SUBMISSION", `created ${rows.length} submission(s) from labels for work=${req.work.work_token} test=${isTest}`);
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
        const rows = await db.createSubmissions(req.work.id, baseLabel, count, isTest);
        log.info("SUBMISSION", `created ${count} submission(s) for work=${req.work.work_token} test=${isTest}`);
        res.json({ submissions: rows });
    } catch (err) {
        log.error("SUBMISSION", `create failed: ${err.message}`);
        res.status(500).json({ error: "failed to create submissions" });
    }
});

// Bloqueio/liberação da entrevista. A checagem efetiva acontece em
// requireSubmissionToken (lib/middleware.js) — todos os endpoints /s/:t/*
// passam por lá e devolvem 403 quando is_blocked=true.
router.patch("/w/:workToken/submissions/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    if (typeof req.body?.is_blocked !== "boolean") {
        return res.status(400).json({ error: "is_blocked (boolean) required" });
    }
    try {
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

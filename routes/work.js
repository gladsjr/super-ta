// Rotas do professor (auth via work_token Bearer).
// Inclui também as rotas de templates de entrevistador (compartilhadas) que
// vivem fora do prefixo /w/* mas são consumidas no fluxo de configuração.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import yaml from "js-yaml";
import { requireWorkToken, requireProfessorSubmission, requireWithinBudget, requireEvaluationOutputsAllowed, sanitizeLabel } from "../lib/middleware.js";
import { publicBaseUrl } from "../lib/publicUrl.js";
import * as db from "../lib/db.js";
import { pickRandomName } from "../lib/personas.js";
import { VOICES, isValidVoice, isRealtimeVoice, voicesFor } from "../config/voices.js";
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
import { configAssistantAgent, enunciadoCoherenceAgent, oralCalibrationAgent } from "../lib/agents.js";
import { validateStudentFeedbackShape, findForbiddenLeaks } from "../agents/StudentFeedbackAgent.js";
import { validateRubricShape, weightedFinal, getEffectiveRubric } from "../lib/rubric.js";
import {
    evaluateSubmissionNow,
    deriveStudentVersionNow,
    gradeSubmissionNow,
    publishSubmissionNow,
    clampGrade,
    workSectionDefaults,
    studentEvaluationPayload,
    SECTION_KEYS,
} from "../lib/evaluationOps.js";
import { workMarkdown } from "../lib/exportMarkdown.js";
import { mapPool } from "../lib/concurrency.js";
import { streamAudio } from "../lib/audioStore.js";
import { serveVideo } from "../lib/serveVideo.js";
import { enqueueProctor, enqueueProctorAndWait } from "../lib/proctorQueue.js";
import { isBatchEligible, summarizeIneligible } from "../lib/batchEligibility.js";
import { ladderState } from "../lib/soundCheck.js";
import { PROCTOR_REVIEW_DEFS, isValidProctorReview, PROCTOR_REVIEW_DEFAULT } from "../lib/proctorReview.js";
import { exceedsPageLimit, MAX_PDF_PAGES } from "../lib/pdfPages.js";
import {
    PRINCIPAL_REASONING_MODEL,
    TTS_MODEL,
    isValidQuestionCount,
    MIN_QUESTION_COUNT,
    MAX_QUESTION_COUNT,
} from "../lib/config.js";
import log from "../lib/logger.js";
import { pool } from "../auth.js";
import { reserveSeats, releaseForSubmission } from "../lib/packages.js";

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
        const calibration = await db.getOralCalibration(req.work.id);
        const hasEnunciado = !!req.work.assignment_pdf;
        // #133: nome do arquivo + checagem mínima de persona (rodada no upload).
        const enunciadoFilename = hasEnunciado ? await db.getEnunciadoFilename(req.work.id) : null;
        const personaCheck = hasEnunciado ? await db.getCoherenceCache(req.work.id) : null;
        // Lista dinâmica que precisa refletir criações/bloqueios na hora. Sem
        // isto, em produção (atrás do Google Frontend) o navegador pode servir
        // uma cópia em cache e o professor não vê o token recém-gerado.
        res.set("Cache-Control", "no-store");
        res.json({
            work: {
                name: req.work.name,
                kind: req.work.kind,
                has_enunciado: hasEnunciado,
                enunciado_filename: enunciadoFilename,
                enunciado_persona_check: personaCheck,
                has_interviewer: !!req.work.has_interviewer,
                interaction_mode: req.work.interaction_mode,
                interview_variant: req.work.interview_variant,
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
                grading_rubric: getEffectiveRubric(req.work),   // rubrica efetiva (do trabalho ou DEFAULT_RUBRIC)
                grade_penalty: req.work.grade_penalty_json || null,   // critério de penalidade por alertas (opt-in)
                proctoring_enabled: !!req.work.proctoring_enabled,    // proctoring por vídeo na entrevista (opt-in)
                devolutiva_proctor_prompt: req.work.devolutiva_proctor_prompt || null,
                oral_calibration: calibration || null,               // frase de calibração de fala (reusa a coluna da oral)
                budget_usd: balance?.budget_usd ?? 0,
                spent_usd: balance?.spent_usd ?? 0,
                remaining_usd: balance?.remaining_usd ?? 0,
                percent_used: balance?.percent_used ?? 100,
            },
            // Escada do sound check v2 (#288): estado por submissão para a lista
            // (vermelho ganha o botão "Liberar sound check").
            submissions: submissions.map(s => ({ ...s, sound_check: ladderState(s.oral_calibration_json) })),
            public_base_url: publicBaseUrl(req),   // origem canônica p/ montar o link do aluno
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
// #351: na variante em tempo real quem fala é o modelo Realtime, que não aceita
// as vozes só-TTS. A lista já sai filtrada para o professor não escolher uma que
// vai ser recusada lá na frente. `realtime` também é devolvido por voz, para a UI
// poder sinalizar quando o professor troca de variante sem recarregar.
router.get("/w/:workToken/voices", requireWorkToken, (req, res) => {
    const somenteRealtime = req.work.interview_variant === "realtime";
    res.json({
        voices: voicesFor({ realtime: somenteRealtime })
            .map(v => ({ id: v.id, label: v.label, gender: v.gender, realtime: v.realtime })),
    });
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
    // #351: na variante em tempo real quem fala é o modelo Realtime, que recusa
    // vozes só-TTS — e recusa a configuração INTEIRA junto. Barrado no save.
    if (mode === "audio" && req.work.interview_variant === "realtime" && !isRealtimeVoice(voice)) {
        return res.status(400).json({ error: `a voz "${voice}" não funciona na entrevista em tempo real — escolha outra` });
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

// Variante da entrevista: 'messages' (profunda, por mensagens) ou 'realtime'
// (simplificada, tempo real por voz — telas estilo prova oral, perguntas do
// plano do PrepBuilder). Só faz sentido em kind='interview'.
router.patch("/w/:workToken/interview-variant", requireWorkToken, express.json({ limit: "4kb" }), async (req, res) => {
    const variant = String(req.body?.variant ?? "");
    if (req.work.kind !== "interview") {
        return res.status(400).json({ error: "variante só se aplica a trabalhos de entrevista" });
    }
    if (variant !== "messages" && variant !== "realtime") {
        return res.status(400).json({ error: "variant deve ser 'messages' ou 'realtime'" });
    }
    try {
        await db.setWorkInterviewVariant(req.work.id, variant);
        log.info("WORK", `interview variant=${variant} work=${req.work.work_token}`);
        res.json({ ok: true, interview_variant: variant });
    } catch (err) {
        log.error("WORK", `set interview variant failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a variante da entrevista", detail: err.message });
    }
});

// ---- Proctoring por vídeo na entrevista (opt-in do professor) ----
// Ligar implica modo áudio (o aluno responde por voz e comanda por gesto). O
// frontend garante isso ao salvar; aqui só persistimos o flag.
router.post("/w/:workToken/proctoring", requireWorkToken, express.json({ limit: "4kb" }), async (req, res) => {
    try {
        const enabled = req.body?.enabled === true;
        await db.setProctoringEnabled(req.work.id, enabled);
        log.info("WORK", `proctoring ${enabled ? "on" : "off"} work=${req.work.work_token}`);
        res.json({ ok: true, proctoring_enabled: enabled });
    } catch (err) {
        log.error("WORK", `set proctoring failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar proctoring", detail: err.message });
    }
});

// Prompt do professor p/ a menção de proctoring na DEVOLUTIVA (linguagem suave).
// Vazio/nulo = usa o default gentil (menção ligada). Texto = instrução do professor
// (pode inclusive pedir para NÃO mencionar). Compartilhado oral+entrevista.
router.post("/w/:workToken/devolutiva-proctor-prompt", requireWorkToken, express.json({ limit: "8kb" }), async (req, res) => {
    try {
        const saved = await db.setDevolutivaProctorPrompt(req.work.id, req.body?.prompt);
        res.json({ ok: true, devolutiva_proctor_prompt: saved });
    } catch (err) {
        log.error("WORK", `set devolutiva proctor prompt failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar o prompt", detail: err.message });
    }
});

// ---- Frase de calibração de fala da ENTREVISTA (reusa oral_calibration_json) ----
// Salvar (editada à mão ou gerada) e Gerar a partir do ENUNCIADO do trabalho. Vazio
// = pré-teste desligado. As rotas orais equivalentes ficam em /oral/calibration.
router.post("/w/:workToken/calibration", requireWorkToken, express.json({ limit: "16kb" }), async (req, res) => {
    try {
        const saved = await db.setOralCalibration(req.work.id, {
            sentence: String(req.body?.sentence ?? ""),
            key_terms: Array.isArray(req.body?.key_terms) ? req.body.key_terms : [],
        });
        log.info("WORK", `calibration saved work=${req.work.work_token} ${saved ? "on" : "off"}`);
        res.json({ ok: true, calibration: saved });
    } catch (err) {
        log.error("WORK", `save calibration failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a frase de calibração" });
    }
});
router.post("/w/:workToken/calibration/generate", requireWorkToken, requireWithinBudget, async (req, res) => {
    try {
        const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
        if (!enunciadoBlob) return res.status(409).json({ error: "envie o enunciado do trabalho antes de gerar a frase" });
        const fileUpload = await uploadPdf(enunciadoBlob, "enunciado.pdf");
        const { sentence, key_terms } = await oralCalibrationAgent.build({ openaiFileId: fileUpload.id, meterCtx: { workId: req.work.id } });
        const saved = await db.setOralCalibration(req.work.id, { sentence, key_terms });
        log.info("WORK", `calibration generated work=${req.work.work_token} terms=${key_terms.length}`);
        res.json({ ok: true, calibration: saved });
    } catch (err) {
        log.error("WORK", `gen calibration failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a frase de calibração", detail: err.message });
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
        // Retranscrição de auditoria (#289, variante realtime): texto do áudio
        // contínuo do tee, em convivência — a UI mostra num bloco próprio.
        try {
            const ft = await db.getFinalTranscript(found.id);
            if (conversation && ft) conversation.final_transcript = ft;
        } catch (err) {
            log.error("WORK", `final transcript load failed submission=${subToken}: ${err.message}`);
        }
        // Proctoring por vídeo (entrevista): relatório já analisado (se houver) e se
        // existe vídeo gravado — a UI mostra os alertas, o botão "Analisar vídeo" e o player.
        let proctoring = null;
        // Na entrevista SIMPLIFICADA (tempo real) o vídeo é inerente à via
        // (câmera sempre ligada, como na prova oral) — o painel de proctoring
        // aparece independente do opt-in da entrevista por mensagens.
        if (req.work.proctoring_enabled || req.work.interview_variant === "realtime") {
            const [detail, parts] = await Promise.all([
                db.getOralSubmissionDetail(found.id),
                db.getOralVideoParts(found.id),
            ]);
            const review = await db.getProctorReview(found.id);
            proctoring = {
                enabled: true,
                report: detail?.oral_proctor_json || null,
                video_parts: parts.length,
                status: detail?.oral_voice_json?.proctor_status?.state || null,
                // Triagem do professor (#246) + o catálogo de níveis, para a tela
                // montar o seletor sem duplicar a enumeração.
                review: review || { level: PROCTOR_REVIEW_DEFAULT, note: null, reviewed_at: null },
                review_levels: PROCTOR_REVIEW_DEFS.map(d => ({ key: d.key, name: d.name })),
            };
        }
        res.json({
            work: { work_token: req.work.work_token, name: req.work.name },
            submission: { submission_token: subToken, student_label: found.student_label, status: found.status },
            conversation,
            proctoring,
        });
    } catch (err) {
        log.error("WORK", `conversation lookup failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to read conversation" });
    }
});

// Reprocessa o proctoring por vídeo de UMA submissão da entrevista (botão ao lado
// do 'falhou', #264). Não roda inline: ENFILEIRA na fila global (#262) com
// prioridade manual e responde na hora — o painel acompanha pelo estado persistido.
router.post("/w/:workToken/submissions/:subToken/proctor", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    try {
        if (req.work.proctoring_enabled !== true && req.work.interview_variant !== "realtime") {
            return res.status(400).json({ error: "proctoring desligado neste trabalho" });
        }
        const parts = await db.getOralVideoParts(req.submission.id);
        if (!parts.length) return res.status(409).json({ error: "esta submissão não tem vídeo gravado" });
        enqueueProctor(req.submission.id, { priority: "manual", tokenForLog: req.submission.submission_token }).catch(() => {});
        res.status(202).json({ ok: true, queued: true });
    } catch (err) {
        log.error("WORK", `proctor (interview) enqueue failed: ${err.message}`);
        res.status(500).json({ error: "falha ao enfileirar a análise", detail: err.message });
    }
});

// Triagem do professor sobre os indícios de fiscalização (#246). A classificação
// é HUMANA — compatível com a ADR 0004, que proíbe acusação/penalidade
// AUTOMÁTICA. A nota NÃO muda por causa deste campo: quem ajusta é o professor.
router.put("/w/:workToken/submissions/:subToken/proctor-review", requireWorkToken, requireProfessorSubmission, express.json({ limit: "8kb" }), async (req, res) => {
    try {
        const level = String(req.body?.level ?? "").trim();
        if (!isValidProctorReview(level)) {
            return res.status(400).json({ error: "nível de triagem inválido" });
        }
        const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : null;
        const saved = await db.setProctorReview(req.submission.id, level, note || null);
        log.info("WORK", `triagem de fiscalização submission=${req.submission.submission_token} nivel=${level}${note ? " (com observação)" : ""}`);
        res.json({ ok: true, review: saved });
    } catch (err) {
        log.error("WORK", `proctor-review failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a triagem" });
    }
});

// Professor assiste ao vídeo do proctoring da entrevista (Range/seek). Espelha a rota
// da prova oral, mas para o kind entrevista. Auth por token do trabalho + submissão dele.
router.get("/w/:workToken/submissions/:subToken/proctor-video/:idx?", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    try {
        const parts = await db.getOralVideoParts(req.submission.id);
        const idx = req.params.idx != null ? parseInt(req.params.idx, 10) : 0;
        const i = Number.isFinite(idx) ? idx : 0;
        const key = parts[i];
        if (!key) return res.status(404).json({ error: "sem vídeo para esta submissão" });
        // #349: streaming parcial de verdade. O tamanho sai de object_sizes
        // (gravado no upload); sem ele, o helper serve inteiro em stream — nunca
        // carrega o arquivo em memória.
        // `await` (e não só `return`): sem ele o catch abaixo não captura a
        // rejeição, e um erro vira unhandledRejection com a requisição pendurada.
        return await serveVideo(req, res, key, `submission=${req.submission.submission_token}`);
    } catch (err) {
        log.error("WORK", `proctor-video serve failed: ${err.message}`);
        res.status(500).json({ error: "falha ao servir o vídeo" });
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
        const [cached, student, grades] = await Promise.all([
            db.getEvaluationCache(found.id),
            db.getStudentEvaluation(found.id),
            db.getSubmissionGrades(found.id),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            evaluation: cached?.report ?? null,
            evaluated_at: cached?.evaluated_at ?? null,
            feedback_guidelines: req.work.feedback_guidelines,
            rubric: getEffectiveRubric(req.work),   // critérios efetivos (do trabalho ou DEFAULT_RUBRIC)
            grades: grades ?? null,                  // notas computadas (com justificativas — professor-only)
            ...studentEvaluationPayload(student),
        });
    } catch (err) {
        log.error("EVALUATION", `read failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to read evaluation" });
    }
});

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

// Rubrica de notas do TRABALHO: critérios (nome, peso, prompt) que o
// GradingAgent aplica sobre a avaliação interna. Vale como padrão de todos os
// alunos (ajuste ad-hoc por aluno vem na rota de notas). Substitui a rubrica
// inteira (não é parcial).
router.patch("/w/:workToken/grading-rubric", requireWorkToken, express.json({ limit: "64kb" }), async (req, res) => {
    let criteria;
    try { criteria = validateRubricShape(req.body?.criteria); }
    catch (err) { return res.status(400).json({ error: `rubrica inválida: ${err.message}` }); }
    try {
        await db.setWorkRubric(req.work.id, criteria);
        log.info("GRADING", `rubric saved work=${req.work.work_token} criteria=${criteria.length}`);
        res.json({ ok: true, rubric: criteria });
    } catch (err) {
        log.error("GRADING", `rubric save failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a rubrica" });
    }
});

// ---- Devolutiva ao aluno: gerar (prévia) é SEPARADO de publicar ----
// A avaliação interna NUNCA vai crua ao aluno. O fluxo é: gerar a versão
// formativa (StudentFeedbackAgent) → professor revisa a prévia (e pode
// EDITAR; a automática fica preservada em coluna própria) → publicar.
// Publicar nunca gera: exige versão existente.

// Gera a versão automática (prévia, sem publicar). ?force=true regenera.
// Body opcional { guidelines }: diretriz AD-HOC desta geração (experimento
// num aluno) — NÃO altera o padrão do trabalho. Ausente = usa o padrão.
router.post("/w/:workToken/submissions/:subToken/evaluation/student-version", requireWorkToken, requireProfessorSubmission, requireEvaluationOutputsAllowed, requireWithinBudget, express.json({ limit: "32kb" }), async (req, res) => {
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
        // Entrevista (#274): o summary é o comentário ABERTO e OPCIONAL do
        // professor — vazio é válido.
        try { validateStudentFeedbackShape(report, { requireSummary: false }); }
        catch (err) { return res.status(400).json({ error: `devolutiva inválida: ${err.message}` }); }
        // A opinião do entrevistador NÃO é editável — vem sempre do relatório
        // interno na composição da efetiva. Qualquer cópia enviada é descartada.
        delete report.interviewer_opinion;
        await db.setStudentEvaluationEdited(found.id, report);
        const student = await db.getStudentEvaluation(found.id);
        const warnings = findForbiddenLeaks(report);
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

// Calcula as notas DESTE aluno. ?force=true recalcula. Body opcional
// { rubricOverride: [...] }: rubrica AD-HOC só deste aluno (não muta o padrão
// do trabalho) — espelha o override de diretrizes da devolutiva.
router.post("/w/:workToken/submissions/:subToken/evaluation/grades", requireWorkToken, requireProfessorSubmission, requireEvaluationOutputsAllowed, requireWithinBudget, express.json({ limit: "64kb" }), async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    const force = String(req.query?.force ?? "").toLowerCase() === "true";
    let rubricOverride;
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "rubricOverride") && req.body.rubricOverride != null) {
        try { rubricOverride = validateRubricShape(req.body.rubricOverride); }
        catch (err) { return res.status(400).json({ error: `rubrica inválida: ${err.message}` }); }
    }
    try {
        const result = await gradeSubmissionNow(req.work, found, { force, rubricOverride });
        res.json(result);
    } catch (err) {
        if (err.notReady) return res.status(err.httpStatus ?? 409).json({ error: err.message });
        log.error("GRADING", `failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao calcular as notas", detail: err.message });
    }
});

// Override MANUAL das notas pelo professor (soberania): body { scores:
// [{criterion_id, score}] }. Recalcula a nota final em código. Exige notas já
// calculadas. Não custa LLM.
router.put("/w/:workToken/submissions/:subToken/evaluation/grades", requireWorkToken, requireProfessorSubmission, express.json({ limit: "32kb" }), async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    const scores = req.body?.scores;
    if (!Array.isArray(scores) || scores.length === 0) {
        return res.status(400).json({ error: "scores deve ser um array de { criterion_id, score }" });
    }
    try {
        let existing = await db.getSubmissionGrades(found.id);
        if (!existing || !Array.isArray(existing.criteria)) {
            // Sem cálculo automático: semeia a rubrica efetiva com notas em branco
            // para o professor lançar as notas à mão. A final é a média ponderada
            // das que ele preencher (weightedFinal ignora as vazias).
            const rubric = getEffectiveRubric(req.work);
            existing = {
                criteria: rubric.map(c => ({ id: c.id, name: c.name, weight: c.weight, score: null, justification: "" })),
                final: null,
                computed_at: new Date().toISOString(),
            };
        }
        const byId = new Map(scores.map(s => [String(s.criterion_id), s.score]));
        const criteria = existing.criteria.map(c => {
            if (!byId.has(String(c.id))) return c;
            const n = clampGrade(byId.get(String(c.id)));
            return n == null ? c : { ...c, score: n, manual: true };
        });
        const gradesObj = { criteria, final: weightedFinal(criteria), computed_at: existing.computed_at ?? new Date().toISOString() };
        await db.setSubmissionGrades(found.id, gradesObj);
        const grades = await db.getSubmissionGrades(found.id);
        log.info("GRADING", `manual scores saved submission=${subToken} final=${grades?.final}`);
        res.json({ grades, generated: false });
    } catch (err) {
        log.error("GRADING", `manual save failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar as notas", detail: err.message });
    }
});

// Publica a NOTA ao aluno (independente da devolutiva). Exige nota calculada.
router.post("/w/:workToken/submissions/:subToken/evaluation/grade-publish", requireWorkToken, requireProfessorSubmission, requireEvaluationOutputsAllowed, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
        const existing = await db.getSubmissionGrades(found.id);
        if (!existing) return res.status(409).json({ error: "não há nota calculada para publicar — calcule primeiro" });
        await db.setGradePublished(found.id, true);
        const grades = await db.getSubmissionGrades(found.id);
        log.info("PUBLISH", `grade published submission=${subToken}`);
        res.json({ grades });
    } catch (err) {
        log.error("PUBLISH", `grade publish failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao publicar a nota", detail: err.message });
    }
});

// Despublica a nota (a nota fica guardada; republicar não recalcula).
router.delete("/w/:workToken/submissions/:subToken/evaluation/grade-publish", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    const subToken = found.submission_token;
    try {
        await db.setGradePublished(found.id, false);
        const grades = await db.getSubmissionGrades(found.id);
        log.info("PUBLISH", `grade unpublished submission=${subToken}`);
        res.json({ grades });
    } catch (err) {
        log.error("PUBLISH", `grade unpublish failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "falha ao despublicar a nota" });
    }
});

router.post("/w/:workToken/submissions/:subToken/evaluation/publish", requireWorkToken, requireProfessorSubmission, requireEvaluationOutputsAllowed, async (req, res) => {
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
        ineligible: state.ineligible || {},
        started_at: state.started_at,
        finished_at: state.finished_at,
    };
}

// A rota de avaliação em lote usa o runner genérico `startBatchRoute` (definido
// adiante). A avaliação custa LLM (checkBudget=true) e mapeia cache-hit ->
// "pulada", igual aos lotes de devolutiva.
// "Avaliar entrevistas" (lote) = PIPELINE COMPLETO por aluno, num clique só:
//   (1) análise do vídeo (proctoring) PRIMEIRO — alimenta a devolutiva;
//   (2) avaliação interna (relatório do entrevistador);
//   (3) devolutiva automática (resumo do relatório + proctoring, sanitizada).
// A ordem (vídeo → avaliação → devolutiva) garante que a devolutiva considere o
// vídeo. Sem botão separado de "analisar vídeo" nem de "gerar devolutiva".
// Candidatas: têm conversa e ainda não têm devolutiva (o produto final). A
// elegibilidade fina é decidida item a item — não-prontas contam como "puladas".
router.post("/w/:workToken/evaluations", requireWorkToken, requireWithinBudget, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchEvalRuns,
    scope: "EVALUATION",
    queueFilter: (s, force) => force || !s.has_student_version, // elegibilidade já filtrada (#258)
    emptyError: force => force
        ? "nenhuma entrevista com conversa para avaliar"
        : "nenhuma entrevista nova para avaliar — todas as elegíveis já foram avaliadas",
    itemFn: async (work, found, force) => {
        // (1) Vídeo: best-effort — falha na análise NÃO derruba a avaliação.
        // Passa pela FILA GLOBAL (#262) e AGUARDA a vez: respeita a concorrência
        // configurada (não fura o teto de CPU/RAM) e deduplica com o disparo
        // automático pós-sessão que pode estar em curso.
        if (work.proctoring_enabled === true || work.interview_variant === "realtime") {
            try {
                const parts = await db.getOralVideoParts(found.id);
                const detail = await db.getOralSubmissionDetail(found.id);
                if (parts.length && (force || !(detail && detail.oral_proctor_json))) {
                    // Aguarda o DESFECHO (#338): a avaliação do lote vem depois
                    // da análise; a espera respeita a concorrência da lane.
                    await enqueueProctorAndWait(found.id, { tokenForLog: found.submission_token });
                }
            } catch (e) {
                log.error("EVALUATION", `proctor (lote) sub=${found.submission_token} falhou (ignorado): ${e.message}`);
            }
        }
        // (2) Avaliação interna (idempotente; sem resposta → notReady → pulada).
        await evaluateSubmissionNow(work, found, { force });
        // (3) Devolutiva automática, com os defaults de visibilidade do trabalho.
        await db.setSubmissionSections(found.id, workSectionDefaults(work));
        const dv = await deriveStudentVersionNow(work, found, { force });
        return { skipped: !dv.generated };
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
const batchDeriveRuns = new Map();       // work.id -> estado (gerar prévias)
const batchPublishRuns = new Map();      // work.id -> estado (publicar devolutivas)
const batchUnpublishRuns = new Map();    // work.id -> estado (despublicar devolutivas)
const batchGradeRuns = new Map();        // work.id -> estado (calcular notas)
const batchGradePublishRuns = new Map();   // work.id -> estado (publicar notas)
const batchGradeUnpublishRuns = new Map(); // work.id -> estado (despublicar notas)

function anyBatchRunning(workId) {
    return batchEvalRuns.get(workId)?.running
        || batchDeriveRuns.get(workId)?.running
        || batchPublishRuns.get(workId)?.running
        || batchUnpublishRuns.get(workId)?.running
        || batchGradeRuns.get(workId)?.running
        || batchGradePublishRuns.get(workId)?.running
        || batchGradeUnpublishRuns.get(workId)?.running;
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
            // Elegibilidade de LOTE vem primeiro e `force` NÃO a fura (#258):
            // refazer o que já foi feito é uma coisa; arrastar teste, arguição em
            // andamento e desistência para dentro do lote é outra.
            const eligible = subs.filter(isBatchEligible);
            const ineligible = summarizeIneligible(subs);
            const queue = eligible.filter(s => queueFilter(s, force));
            if (queue.length === 0) {
                return res.status(400).json({ error: emptyError(force), ineligible });
            }
            const state = newBatchState(force, queue.length);
            state.ineligible = ineligible;
            map.set(req.work.id, state);
            runBatchOver(scope, req.work, queue, state, found => itemFn(req.work, found, force), { checkBudget })
                .catch(err => {
                    log.error(scope, `batch crashed work=${req.work.work_token}: ${err.message}`);
                    state.running = false;
                    state.finished_at = new Date().toISOString();
                    state.stopped_reason = "internal_error";
                });
            res.json({ started: true, total: queue.length, force, ineligible });
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

// Lote de DESPUBLICAR devolutivas: submissões com devolutiva publicada. Não custa
// LLM (só retira a visibilidade; a devolutiva fica guardada para republicar).
router.post("/w/:workToken/evaluations/unpublish", requireWorkToken, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchUnpublishRuns,
    scope: "PUBLISH",
    queueFilter: (s) => !!s.evaluation_published_at,
    emptyError: () => "nenhuma devolutiva publicada para despublicar",
    itemFn: async (work, found) => {
        await db.setEvaluationPublished(found.id, false);
        return { skipped: false };
    },
    checkBudget: false,
}));

// Lote de NOTAS: submissões COM avaliação interna; sem force, pula as que já
// têm nota. Custa LLM (uma chamada por critério × submissão).
router.post("/w/:workToken/evaluations/grades", requireWorkToken, requireWithinBudget, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchGradeRuns,
    scope: "GRADING",
    queueFilter: (s, force) => s.has_evaluation && (force || !s.has_grades),
    emptyError: force => force
        ? "nenhuma submissão com avaliação — avalie as entrevistas antes de calcular notas"
        : "nenhuma nota nova para calcular — todas as avaliadas já têm nota",
    itemFn: async (work, found, force) => {
        const r = await gradeSubmissionNow(work, found, { force });
        return { skipped: !r.generated };
    },
    checkBudget: true,
}));

// Lote de PUBLICAR NOTAS: submissões COM nota calculada; sem force, pula as já
// publicadas. Não custa LLM (só marca grade_published_at).
router.post("/w/:workToken/evaluations/grade-publish", requireWorkToken, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchGradePublishRuns,
    scope: "PUBLISH",
    queueFilter: (s, force) => s.has_grades && (force || !s.grade_published_at),
    emptyError: force => force
        ? "nenhuma nota calculada para publicar — calcule as notas antes"
        : "nenhuma nota nova para publicar — todas as calculadas já estão publicadas",
    itemFn: async (work, found) => {
        await db.setGradePublished(found.id, true);
        return { skipped: false };
    },
    checkBudget: false,
}));

// Lote de DESPUBLICAR NOTAS: submissões com nota PUBLICADA. Sem force, pula as
// que já estão despublicadas. Não custa LLM. Inverso do grade-publish.
router.post("/w/:workToken/evaluations/grade-unpublish", requireWorkToken, express.json({ limit: "8kb" }), startBatchRoute({
    map: batchGradeUnpublishRuns,
    scope: "PUBLISH",
    queueFilter: (s, force) => s.has_grades && (force || !!s.grade_published_at),
    emptyError: () => "nenhuma nota publicada para despublicar",
    itemFn: async (work, found) => {
        await db.setGradePublished(found.id, false);
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
        unpublish: publicBatchState(batchUnpublishRuns.get(req.work.id)),
        grade: publicBatchState(batchGradeRuns.get(req.work.id)),
        grade_publish: publicBatchState(batchGradePublishRuns.get(req.work.id)),
        grade_unpublish: publicBatchState(batchGradeUnpublishRuns.get(req.work.id)),
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
    if (exceedsPageLimit(req.file.buffer)) {
        return res.status(400).json({ error: `o enunciado tem mais de ${MAX_PDF_PAGES} páginas — envie um PDF menor (limite ${MAX_PDF_PAGES})` });
    }
    try {
        await db.setEnunciadoBlob(req.work.id, req.file.buffer, req.file.originalname);
        await db.clearCoherenceCache(req.work.id);
        log.info("WORK", `enunciado uploaded work=${req.work.work_token} bytes=${req.file.size} name=${req.file.originalname}`);
        // No upload rodam DUAS tarefas automáticas, ambas best-effort (se falharem,
        // o upload NÃO falha — o professor sempre consegue subir o arquivo). O PDF é
        // subido ao OpenAI UMA vez e reusado pelas duas:
        //   (a) #133: checagem MÍNIMA de persona (barata, fast_model). Some o botão
        //       "Avaliar"/"Reavaliar" e o bug de avaliar o enunciado ANTIGO.
        //   (b) frase de calibração de fala, gerada em SILÊNCIO (o professor não lida
        //       com calibração nem vê/edita a frase — some o card de calibração).
        let personaCheck = null;
        let calibrationGenerated = false;
        try {
            const fileUpload = await uploadPdf({ pdf: req.file.buffer, filename: req.file.originalname }, "enunciado.pdf");
            try {
                personaCheck = await enunciadoCoherenceAgent.evaluate({ openaiFileId: fileUpload.id, meterCtx: { workId: req.work.id } });
                await db.setCoherenceCache(req.work.id, personaCheck);
            } catch (chkErr) {
                log.error("WORK", `enunciado persona-check failed work=${req.work.work_token}: ${chkErr.message}`);
            }
            try {
                const { sentence, key_terms } = await oralCalibrationAgent.build({ openaiFileId: fileUpload.id, meterCtx: { workId: req.work.id } });
                await db.setOralCalibration(req.work.id, { sentence, key_terms });
                calibrationGenerated = true;
            } catch (calErr) {
                log.error("WORK", `enunciado calibration auto-gen failed work=${req.work.work_token}: ${calErr.message}`);
            }
        } catch (upErr) {
            log.error("WORK", `enunciado openai-upload failed work=${req.work.work_token}: ${upErr.message}`);
        }
        res.json({ ok: true, filename: req.file.originalname, persona_check: personaCheck, calibration_generated: calibrationGenerated });
    } catch (err) {
        log.error("WORK", `enunciado save failed: ${err.message}`);
        res.status(500).json({ error: "failed to save enunciado" });
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

    // Checagem MÍNIMA de persona (#133): roda sozinha no upload. NÃO há ação para
    // "avaliar enunciado" — não sugira nem emita request_assignment_check.
    if (!coherence || !coherence.persona) {
        return `${header}
- Persona do entrevistador no enunciado: ${work.assignment_pdf ? "o enunciado NÃO deixa claro com quem o aluno vai conversar (oriente o professor a descrever a persona no enunciado)" : "enunciado ainda não enviado"}. (A checagem roda automaticamente no upload; não há ação para avaliar o enunciado.)`;
    }
    return `${header}
- Persona do entrevistador identificada no enunciado: ${coherence.persona}${(coherence.characteristics || []).length ? ` — características: ${coherence.characteristics.join(", ")}` : ""}. (Checagem automática do upload; não há ação para reavaliar.)`;
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

    // Monta a lista de rótulos — dois modos: lista de nomes OU rótulo-base + contagem.
    let labels;
    const rawLabels = req.body?.labels;
    if (Array.isArray(rawLabels)) {
        labels = [];
        for (let i = 0; i < rawLabels.length; i++) {
            const raw = String(rawLabels[i] ?? "").trim();
            if (!raw) continue; // ignora linhas vazias silenciosamente
            try { labels.push(sanitizeLabel(raw)); }
            catch (err) { return res.status(400).json({ error: `linha ${i + 1}: ${err.message}` }); }
        }
        if (labels.length === 0) return res.status(400).json({ error: "lista vazia (nenhum nome válido)" });
        if (labels.length > BULK_LABEL_CAP) return res.status(400).json({ error: `máximo de ${BULK_LABEL_CAP} nomes por envio` });
    } else {
        let baseLabel;
        try { baseLabel = sanitizeLabel(req.body?.label); }
        catch (err) { return res.status(400).json({ error: err.message }); }
        const rawCount = Number(req.body?.count ?? 1);
        const count = Number.isFinite(rawCount) && rawCount > 0 && rawCount <= 50 ? Math.floor(rawCount) : 1;
        labels = [];
        for (let i = 0; i < count; i++) labels.push(count > 1 ? `${baseLabel}-${i + 1}` : baseLabel);
    }

    // Cria os tokens E reserva os assentos do pacote (Gate B) na MESMA transação:
    // gerar token é onde o professor "ameaça gastar". ALL-OR-NOTHING — se o lote não
    // couber na cota, não cria nada. Token de teste também conta (é custo). Trabalho
    // fora de pacote → reserva é no-op (só vale o orçamento US$).
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const rows = await db.createSubmissionsFromLabels(req.work.id, labels, isTest, client);
        const reserve = await reserveSeats(client, {
            workId: req.work.id,
            submissionIds: rows.map((r) => r.id),
            byUserId: req.session?.user?.id ?? null,
        });
        if (!reserve.ok) {
            await client.query("ROLLBACK");
            const detail = reserve.reason === "no_counter"
                ? "Este trabalho está vinculado a um pacote sem cota configurada na unidade. Procure o administrador."
                : `A cota de "${reserve.itemKey}" nesta turma não cobre ${labels.length} envio(s) — restam ${reserve.available}. Apague envios não usados ou peça mais pacotes.`;
            return res.status(402).json({ error: "entitlement_exhausted", gate: "package", item: reserve.itemKey, available: reserve.available ?? 0, needed: labels.length, detail });
        }
        await client.query("COMMIT");
        log.info("SUBMISSION", `created ${rows.length} submission(s) for work=${req.work.work_token} test=${isTest} reserved=${reserve.skipped ? "n/a" : reserve.count}`);
        // Remove o id interno antes de responder (o frontend usa só o token).
        return res.json({ submissions: rows.map(({ id, ...rest }) => rest) });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        log.error("SUBMISSION", `create failed: ${err.message}`);
        return res.status(500).json({ error: "failed to create submissions" });
    } finally {
        client.release();
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

// Liberar o aluno a concluir SEM vídeo — válvula de escape do gate de proctoring
// obrigatório (câmera/navegador do aluno genuinamente incompatível). Marca
// video_waived e, se a submissão estava 'aguardando vídeo', conclui na hora.
router.post("/w/:workToken/submissions/:subToken/waive-video", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    try {
        await db.waiveSubmissionVideo(found.id);
        log.info("SUBMISSION", `vídeo liberado (waive) submission=${found.submission_token} work=${req.work.work_token}`);
        res.json({ ok: true, submission_token: found.submission_token, video_waived: true });
    } catch (err) {
        log.error("SUBMISSION", `waive-video failed submission=${found.submission_token}: ${err.message}`);
        res.status(500).json({ error: "falha ao liberar sem vídeo" });
    }
});

// Liberar o aluno reprovado no SOUND CHECK (#288, ADR 0023): a escada vermelha
// (2 sinais duros de captação) não segue sozinha; o professor decide assumir.
// Liberação PERMANENTE para esta submissão (grava waived_at no registro).
router.post("/w/:workToken/submissions/:subToken/waive-soundcheck", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    try {
        await db.setOralCalibrationResult(found.id, { waived_at: new Date().toISOString() });
        log.info("SUBMISSION", `sound check liberado (waive) submission=${found.submission_token} work=${req.work.work_token}`);
        res.json({ ok: true, submission_token: found.submission_token, sound_check_waived: true });
    } catch (err) {
        log.error("SUBMISSION", `waive-soundcheck failed submission=${found.submission_token}: ${err.message}`);
        res.status(500).json({ error: "falha ao liberar o sound check" });
    }
});

// Liberar a RETOMADA de uma sessão de voz que caiu (#260). A queda pausa o
// aluno (lib/resumeGate.js); aqui o professor autoriza UMA retomada — a
// liberação é consumida na próxima conexão (nova queda → novo bloqueio).
// Alternativa que não precisa de rota: avaliar individualmente o que já foi
// gravado (a transcrição parcial e o vídeo existem).
router.post("/w/:workToken/submissions/:subToken/allow-resume", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const found = req.submission;
    try {
        if (found.completion_reason) return res.status(409).json({ error: "a arguição já foi concluída" });
        await db.allowResume(found.id);
        log.info("SUBMISSION", `retomada liberada submission=${found.submission_token} work=${req.work.work_token}`);
        res.json({ ok: true, submission_token: found.submission_token, resume_allowed: true });
    } catch (err) {
        log.error("SUBMISSION", `allow-resume failed submission=${found.submission_token}: ${err.message}`);
        res.status(500).json({ error: "falha ao liberar a retomada" });
    }
});

// Apagar um token de envio. Só quando o aluno NÃO iniciou (status pending): aí
// devolve o assento do pacote ao pool (Gate B) e remove a submissão. Se já
// começou, houve custo — não dá pra apagar nem devolver (bloqueie em vez disso).
router.delete("/w/:workToken/submissions/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    const sub = req.submission;
    if (sub.status !== "pending") {
        return res.status(409).json({ error: "submission_in_use", detail: "só é possível apagar um envio que o aluno ainda não iniciou" });
    }
    // Devolução do assento + delete numa ÚNICA transação (issue #145): se o delete
    // falhar, a devolução de cota é desfeita (nada de reembolso sem apagar o token).
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await releaseForSubmission(sub.id, client); // devolve o assento (no-op se não havia reserva)
        await db.deleteSubmission(sub.id, client);
        await client.query("COMMIT");
        log.info("SUBMISSION", `deleted+refunded submission=${sub.submission_token} work=${req.work.work_token}`);
        res.json({ ok: true, submission_token: sub.submission_token });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        log.error("SUBMISSION", `delete failed submission=${sub.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed to delete submission" });
    } finally {
        client.release();
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

// Exportação das avaliações de TODOS os alunos num único .md (issue #247). Mesmo
// padrão do CSV acima: capacidade pelo work token, resposta como anexo. O
// conteúdo espelha a tela individual (static/conversation.html) menos os
// binários — vídeo e áudios não cabem em texto (os TRECHOS dos indícios entram).
router.get("/w/:workToken/avaliacoes.md", requireWorkToken, async (req, res) => {
    try {
        const rows = await db.listSubmissionsForWork(req.work.id);
        // Leitura por aluno em pool pequeno: são 4 SELECTs cada, e uma turma
        // grande em série ficaria lenta sem necessidade (lib/concurrency.js).
        const results = await mapPool(rows, 4, async (s) => {
            const found = await db.findSubmissionByToken(s.submission_token);
            if (!found) return null;
            const [text, cached, student, finalization, runtime] = await Promise.all([
                db.getConversationJson(found.id),
                db.getEvaluationCache(found.id),
                db.getStudentEvaluation(found.id),
                db.getSubmissionFinalization(found.id),
                db.getSubmissionRuntimeState(found.id),
            ]);
            let conversation = null;
            if (text) {
                try { conversation = JSON.parse(text); }
                catch (err) { log.error("WORK", `export md: conversation parse failed sub=${s.submission_token}: ${err.message}`); }
            }
            // Mesma composição da tela: a finalização autoritativa é a da linha da
            // submission; a despedida durável vem do conversation_json.
            if (conversation && finalization?.completion_reason) {
                const closingMessage = typeof conversation.finalization?.message === "string" ? conversation.finalization.message : null;
                conversation.finalization = {
                    completion_reason: finalization.completion_reason,
                    completed_at: finalization.completed_at,
                    student_comment: finalization.student_comment,
                    message: closingMessage,
                };
            }
            const planQuestions = runtime?.runtime_state?.interview_plan?.questions;
            if (conversation && Array.isArray(planQuestions)) {
                const cursor = typeof runtime.question_index === "number" ? runtime.question_index : 0;
                conversation.pending_questions = planQuestions.slice(cursor).map(q => ({ question: q?.question ?? "" }));
            }
            return {
                submission: s,
                conversation,
                evaluation: cached,
                studentEvaluation: studentEvaluationPayload(student),
                proctorReport: s.oral_proctor_json || null,
                videoParts: Number(s.oral_video_parts_count ?? 0),
                personaName: req.work.interviewer_name || null,
            };
        });
        const submissions = results.filter(r => r.ok && r.value).map(r => r.value);
        const failed = results.filter(r => !r.ok).length;
        if (failed) log.error("WORK", `export md: ${failed} aluno(s) falharam work=${req.work.work_token}`);
        const md = workMarkdown({
            workName: req.work.name,
            generatedAt: new Date().toISOString(),
            submissions,
        });
        log.info("WORK", `export md work=${req.work.work_token} alunos=${submissions.length}`);
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="avaliacoes-${req.work.work_token}.md"`);
        res.send(md);
    } catch (err) {
        log.error("WORK", `export md failed: ${err.message}`);
        res.status(500).json({ error: "failed to export markdown" });
    }
});

export default router;

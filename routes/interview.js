// Rotas do aluno (auth via submission_token Bearer).
// Cinco endpoints: /start, /upload, /audio/:turnId, /chat.
//
// O handler /chat é o coração da orquestração: dispara triagem (3 agents
// fast) + sufficiency (1 reasoning) em paralelo, escolhe entre aceitar e
// avançar a próxima pergunta do plano ou interceptar com um follow-up /
// scope / off-topic / meta.

import express from "express";
import multer from "multer";
import { requireSubmissionToken, requireWithinBudget, requireNotFinalized } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { openai } from "../lib/openaiClient.js";
import { transcribeAudio, AudioCache } from "../lib/audio.js";
import { getAudioDurationSeconds } from "../lib/audioMeta.js";
import { meteredStt } from "../lib/billing.js";
import { STT_MODEL, MAX_RELEVANCE_SKIPS, AUDIO_INTELLIGIBILITY } from "../lib/config.js";
import { pickPersona } from "../lib/personas.js";
import { deleteConversationLog } from "../lib/conversationLog.js";
import { detectIntelligibilitySpans } from "../lib/audioIntelligibility.js";
import {
    introductionAgent,
    answerSufficiencyAgent,
    scopeClarificationAgent,
    offTopicRedirectAgent,
    metaInterventionAgent,
    questionRelevanceAgent,
    audioIntelligibilityAgent,
} from "../lib/agents.js";
import { pickTriageWinner } from "../lib/triage.js";
import {
    turnFromPlanQuestion,
    persistConversationLog,
    logLastConvItem,
} from "../lib/conversationUtils.js";
import {
    SESSIONS,
    startLocks,
    sessionMeterCtx,
    voiceGenderOf,
    sessionToClientState,
    attachAudio,
    maybeRebuildPendingQuestionAudio,
    initOrResumeSession,
    startInterviewPreparation,
} from "../lib/sessionLifecycle.js";
import log from "../lib/logger.js";

// ============================================================================
// Pré-gate de inteligibilidade no modo áudio.
// ----------------------------------------------------------------------------
// Trabalha em duas camadas, separadas por design (ver lib/audioIntelligibility.js):
//   1. Algorítmica (pura): decide SE há trechos ininteligíveis a partir dos
//      logprobs por token do STT. Sem LLM, determinística, configurável via
//      AUDIO_INTELLIGIBILITY no policy.yaml.
//   2. LLM (AudioIntelligibilityAgent): só FRASEIA a fala em personagem, dados
//      os trechos. Modo "ask_repeat" nas primeiras tentativas, "give_up" na
//      N-ésima do mesmo turno — daí o frontend mostra também uma Dica fora do
//      roleplay orientando ações práticas (ajustar mic / desistir+comentar).
//
// Contador de tentativas:
//   - Intro: sess.introAudioAttempts (single, intro inteiro).
//   - Entrevista: currentTurn.audio_repeat_attempts (zera junto com o turno).
//
// A mensagem ininteligível do aluno NÃO é empurrada como turno do usuário —
// fica apenas registrada como intervenção para auditoria do professor.
// ============================================================================
async function runAudioIntelligibilityGate({ sess, transcript, logprobs, persist }) {
    const { spans, aggregate } = detectIntelligibilitySpans(logprobs, {
        low_logprob_threshold: AUDIO_INTELLIGIBILITY.low_logprob_threshold,
        min_consecutive_low_tokens: AUDIO_INTELLIGIBILITY.min_consecutive_low_tokens,
        min_utterance_tokens: AUDIO_INTELLIGIBILITY.min_utterance_tokens,
    });

    // Loga aggregate SEMPRE — passou ou não — para calibração futura dos limiares.
    log.info(
        "AUDIO:Gate",
        `tokens=${aggregate?.totalTokens ?? 0} low=${aggregate?.lowTokens ?? 0}` +
        ` mean=${aggregate?.meanLogprob != null ? aggregate.meanLogprob.toFixed(2) : "—"}` +
        ` min=${aggregate?.minLogprob != null ? aggregate.minLogprob.toFixed(2) : "—"}` +
        ` spans=${spans.length}`
    );

    if (spans.length === 0) return { gated: false };

    // Segmento lógico do contador.
    const inIntro = sess.currentPhase === "intro";
    let attempt;
    if (inIntro) {
        sess.introAudioAttempts = (sess.introAudioAttempts ?? 0) + 1;
        attempt = sess.introAudioAttempts;
    } else {
        const currentTurn = sess.turnLog?.[sess.turnLog.length - 1];
        if (currentTurn) {
            currentTurn.audio_repeat_attempts = (currentTurn.audio_repeat_attempts ?? 0) + 1;
            attempt = currentTurn.audio_repeat_attempts;
        } else {
            attempt = 1;
        }
    }
    const max = AUDIO_INTELLIGIBILITY.max_retries_before_give_up;
    const mode = attempt >= max ? "give_up" : "ask_repeat";

    // Texto da pergunta do turno atual, para dar contexto ao agente de fraseado.
    let currentQuestionText = null;
    if (!inIntro) {
        const currentTurn = sess.turnLog?.[sess.turnLog.length - 1];
        currentQuestionText = currentTurn?.question ?? null;
    }

    let phrased;
    try {
        phrased = await audioIntelligibilityAgent.evaluate({
            mode,
            interviewerYamlText: sess.interviewerYamlText ?? "",
            currentQuestionText,
            transcript,
            spans,
            retryAttempt: attempt,
            maxRetries: max,
            meterCtx: sessionMeterCtx(sess),
            studentName: sess.studentName ?? null,
        });
    } catch (err) {
        log.error("AGENT:AudioIntelligibility", `failed, using fallback: ${err.message}`);
        phrased = {
            message: mode === "give_up"
                ? "Tá difícil entender hoje. Acho melhor a gente continuar essa conversa em outro momento, com o áudio funcionando bem."
                : "Desculpa, não peguei direito essa parte. Pode repetir?",
            reason: "agent_failed",
        };
    }

    // Empurra a fala do entrevistador no conv (visível ao aluno).
    sess.conv_chat.push({ role: "assistant", content: phrased.message });
    sess.conv_eval.push({
        role: "assistant",
        content: phrased.message,
        metadata: { intervention: "audio_intelligibility", mode, attempt, timestamp: Date.now() },
    });
    sess.history = sess.conv_chat;
    try {
        await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: phrased.message }] });
        await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: phrased.message }] });
    } catch (err) {
        log.error("CHAT", `remote write (audio intelligibility) failed: ${err.message}`);
    }
    await logLastConvItem(sess.conversationId_chat, "CONV:chat");

    // Registra a intervenção para auditoria do professor. Reusa os campos
    // padrão (student_message, assistant_response, type, channel, at) para o
    // renderer de conversation.html exibir o card pelo caminho comum; campos
    // extras (mode/attempt/spans/aggregate) sobrevivem no JSONB para auditoria.
    const interventionRecord = {
        type: "audio_intelligibility",
        channel: "chat",
        mode,
        attempt,
        max_attempts: max,
        student_message: transcript,
        spans: spans.map(s => s.text),
        aggregate,
        assistant_response: phrased.message,
        reason: phrased.reason || `algoritmo detectou ${spans.length} trecho(s) de baixa confiança; tentativa ${attempt}/${max}`,
        at: new Date().toISOString(),
    };
    if (inIntro) {
        // Sem currentTurn de plano no intro — registra no introLog com role
        // "system" para o professor.html exibir como linha de auditoria.
        sess.introLog.push({
            role: "system",
            content: `[áudio ininteligível — ${mode}, tentativa ${attempt}/${max}]`,
            metadata: interventionRecord,
            at: new Date().toISOString(),
        });
    } else {
        const currentTurn = sess.turnLog?.[sess.turnLog.length - 1];
        if (currentTurn) {
            if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
            currentTurn.interventions.push(interventionRecord);
        }
    }

    const audio = await attachAudio(sess, phrased.message);
    persist();

    // Dica (fora do roleplay) só aparece no give_up. Texto fixo, editável aqui.
    const hint = mode === "give_up" ? {
        kind: "audio_give_up",
        title: "Problemas com o áudio?",
        body: "O entrevistador não está conseguindo te entender. Você pode tentar ajustar o microfone (ou mudar para um ambiente mais silencioso) e gravar de novo. Se achar que o problema é do sistema, use o botão \"Desistir da entrevista\" no topo, deixe um comentário descrevendo o que aconteceu, e peça outro link ao seu professor.",
    } : null;

    return {
        gated: true,
        response: {
            channel: "chat",
            assistant: phrased.message,
            audio_intelligibility: {
                mode,
                attempt,
                max_attempts: max,
                spans: spans.map(s => s.text),
                hint,
            },
            ...audio,
        },
    };
}

const router = express.Router();

const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MB
const studentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMIT_BYTES },
});
// Áudio do aluno: limite menor (mensagens de voz raramente passam de 1-2 min).
const AUDIO_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB
const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AUDIO_UPLOAD_LIMIT_BYTES },
});

// ============================================================================
// POST /s/:submissionToken/start
// ============================================================================
router.post("/s/:submissionToken/start", requireSubmissionToken, async (req, res) => {
    const token = req.submission.submission_token;

    // Entrevista já finalizada: devolve um estado mínimo "finalized" para o
    // frontend renderizar a tela "Entrevista encerrada", sem carregar/recompor
    // sessão. A conversa em si nunca é re-exibida para o aluno após finalizar
    // (só o professor a vê via /w/.../conversation).
    if (req.submission.completion_reason) {
        return res.json({
            work: { name: req.work.name, has_enunciado: !!req.work.assignment_pdf },
            submission: {
                status: req.submission.status,
                student_label: req.submission.student_label,
                completion_reason: req.submission.completion_reason,
                completed_at: req.submission.completed_at,
            },
            session: { currentPhase: "finalized", finalized: true },
        });
    }

    try {
        let sess = SESSIONS.get(token);
        let pendingAudio = null;
        if (!sess) {
            // Lock em memória por token: dois /start concorrentes (ex.: duas abas)
            // não podem cada um disparar seu próprio rebuild.
            let lock = startLocks.get(token);
            if (!lock) {
                lock = initOrResumeSession(req).finally(() => {
                    startLocks.delete(token);
                });
                startLocks.set(token, lock);
            }
            const result = await lock;
            sess = result.sess;
            pendingAudio = result.pendingAudio;
        } else {
            // SESSIONS hit (mesma sessão de memória): caminho legado, só
            // re-sincroniza mode/voice quando ainda em awaiting_upload.
            if (!sess.audioCache) sess.audioCache = new AudioCache(10);
            if (typeof sess.audioTurnIdCounter !== "number") sess.audioTurnIdCounter = 0;
            if (!sess.interactionMode) sess.interactionMode = "text";
            if (sess.currentPhase === "awaiting_upload") {
                sess.interactionMode = req.work.interaction_mode || "text";
                sess.voice = req.work.voice || null;
                const newVoiceGender = voiceGenderOf(sess.voice);
                const identityOverride = req.work.interviewer_name && req.work.interviewer_gender
                    ? { name: req.work.interviewer_name, gender: req.work.interviewer_gender }
                    : null;
                const needsRepick = identityOverride
                    ? (sess.interviewerPersona?.name !== identityOverride.name
                       || sess.interviewerPersona?.gender !== identityOverride.gender)
                    : ((newVoiceGender === "f" || newVoiceGender === "m")
                       && sess.interviewerPersona?.gender !== newVoiceGender);
                if (needsRepick) {
                    sess.interviewerPersona = pickPersona({
                        voiceGender: newVoiceGender,
                        overrides: identityOverride,
                    });
                }
            }
            log.info("SUBMISSION", `resume(mem) token=${token} phase=${sess.currentPhase} qn=${sess.questionCount} mode=${sess.interactionMode}`);
            // SESSIONS-hit em modo áudio também precisa do último áudio para tocar
            // (reload da aba). Reaproveita o buffer cacheado quando possível.
            pendingAudio = await maybeRebuildPendingQuestionAudio(sess);
        }

        res.json({
            work: { name: req.work.name, has_enunciado: !!req.work.assignment_pdf },
            submission: { status: req.submission.status === "pending" ? "in_progress" : req.submission.status, student_label: req.submission.student_label },
            session: {
                ...sessionToClientState(sess),
                pending_question_audio: pendingAudio,
            },
        });
        // One-shot: o banner "Sessão recomposta" deve aparecer só uma vez. Se o
        // aluno recarregar a página depois (cache hit em SESSIONS), não queremos
        // mostrar de novo.
        if (sess.rebuilt) { sess.rebuilt = false; sess.rebuildReason = null; }
    } catch (err) {
        const status = err.statusCode || 500;
        const message = err.publicMessage || "failed to start submission";
        log.error("SUBMISSION", `start failed (status=${status}): ${err.message}`);
        res.status(status).json({ error: message });
    }
});

// ============================================================================
// POST /s/:submissionToken/upload
// ============================================================================
router.post("/s/:submissionToken/upload", requireSubmissionToken, requireNotFinalized, requireWithinBudget, studentUpload.single("file"), async (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(400).json({ error: "call /start first" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    // Bloqueia re-upload quando já existe entrevista em andamento. O contrato é:
    // para reiniciar, o professor gera um novo envio. Fonte de verdade é o BD
    // (não o SESSIONS em memória), porque após restart a entrevista ainda existe
    // mesmo que a memória esteja vazia.
    const rt = await db.getSubmissionRuntimeState(req.submission.id);
    if (rt && rt.current_phase && rt.current_phase !== "awaiting_upload") {
        return res.status(409).json({
            error: "Uma entrevista já foi iniciada para este link. Para reiniciar, peça ao professor um novo envio.",
        });
    }

    const studentBuffer = req.file.buffer;
    const studentFilename = req.file.originalname;
    sess.submissionPath = studentFilename;
    sess.studentLabel = req.submission.student_label;

    // New upload = new interview attempt. Reset log state e wipe any previous
    // conversation log so the professor only ever sees the current attempt.
    sess.turnLog = [];
    sess.skippedQuestions = [];
    sess.conversationStartedAt = new Date().toISOString();
    sess.conversationCompleted = false;
    // Re-sincroniza modo de interação e voz com o estado atual do trabalho.
    // Cada upload é uma nova tentativa de entrevista — pega o modo
    // configurado AGORA. Durante a entrevista (após este upload), o modo
    // fica imutável até o próximo upload.
    sess.interactionMode = req.work.interaction_mode || "text";
    sess.voice = req.work.voice || null;
    // Cada upload reinicia a entrevista. Persona segue, em ordem de prioridade:
    // (1) override do professor (works.interviewer_name/gender), (2) gênero da
    // voz no modo áudio, (3) sorteio balanceado em modo texto.
    const identityOverride = req.work.interviewer_name && req.work.interviewer_gender
        ? { name: req.work.interviewer_name, gender: req.work.interviewer_gender }
        : null;
    sess.interviewerPersona = pickPersona({
        voiceGender: voiceGenderOf(sess.voice),
        overrides: identityOverride,
    });
    log.info("SUBMISSION", `upload token=${token} mode=${sess.interactionMode} voice=${sess.voice ?? "-"} persona=${sess.interviewerPersona.name}/${sess.interviewerPersona.city}`);
    try { await deleteConversationLog(req.submission.id); }
    catch (err) { log.error("LOG", `delete old conversation log failed: ${err.message}`); }

    // Reads do DB em paralelo (são leves, mas não há razão para sequenciar).
    const [interviewerYamlText, enunciadoBlob] = await Promise.all([
        db.getInterviewerYaml(req.work.id),
        db.getEnunciadoBlob(req.work.id),
    ]);
    if (!interviewerYamlText) {
        return res.status(400).json({ error: "O professor ainda não configurou o entrevistador para este trabalho." });
    }
    if (!enunciadoBlob) {
        return res.status(400).json({ error: "O professor ainda não enviou o enunciado para este trabalho." });
    }

    try {
        log.info("UPLOAD", `student file=${studentFilename} bytes=${studentBuffer.length} submission=${token}`);

        sess.interviewerYamlText = interviewerYamlText;
        sess.currentPhase = "intro";
        sess.questionIndex = 1;
        const meterCtx = sessionMeterCtx(sess);

        // ESTRATÉGIA DE LATÊNCIA: o cumprimento de abertura usa apenas o YAML do
        // entrevistador e a persona — nada do upload do aluno, nada do vector
        // store. Disparamos a saudação (fast model, ~1-2s) em paralelo com TODA
        // a preparação pesada (uploads de PDF, vector store, document map, plano
        // de entrevista). O caminho crítico até o aluno ver a saudação fica em
        // O(saudação), em vez de O(uploads + vector store + saudação).
        //
        // Inputs da prep ficam guardados na sessão para permitir retry caso a
        // primeira execução em background falhe (ex.: timeout transitório de
        // rede). Sem isso, uma falha durante a fase intro deixaria o aluno preso.
        sess.preparationInputs = {
            submissionId: req.submission.id,
            studentBuffer,
            studentFilename,
            enunciadoBlob,
            meterCtx,
            token,
        };
        startInterviewPreparation(sess);

        // Beat 1 do roteiro de abertura: apresenta-se (nome + papel) e pergunta
        // só o nome do aluno. Disparado em paralelo com a prep pesada acima — é
        // só ele que precisa terminar para responder ao aluno.
        sess.introStep = "awaiting_name";
        const greeting = await introductionAgent.evaluate({
            step: "ask_name",
            interviewerYamlText,
            persona: sess.interviewerPersona,
            introHistory: sess.introLog,
            studentMessage: null,
            meterCtx,
            interactionMode: sess.interactionMode,
        });

        // TTS antes do push para podermos persistir a duração junto com o item.
        const audio = await attachAudio(sess, greeting.message);
        const greetingEntry = {
            role: "assistant",
            content: greeting.message,
            at: new Date().toISOString(),
            audio_duration_seconds: audio.audio_duration_seconds ?? null,
        };
        sess.introLog.push(greetingEntry);
        sess.conv_chat.push({ role: "assistant", content: greeting.message });
        sess.conv_eval.push({ role: "assistant", content: greeting.message, metadata: { phase: "intro", persona: sess.interviewerPersona, timestamp: Date.now() } });
        sess.history = sess.conv_chat;

        try {
            await openai.conversations.items.create(sess.conversationId_chat, {
                items: [{ role: "assistant", content: greeting.message }],
            });
            await openai.conversations.items.create(sess.conversationId_eval, {
                items: [{ role: "assistant", content: greeting.message }],
            });
        } catch (err) {
            log.error("CHAT", `remote write (intro greeting) failed: ${err.message}`);
        }

        log.info("CHAT", `intro greeting persona=${sess.interviewerPersona.name}/${sess.interviewerPersona.city} ${log.preview(greeting.message, 120)}`);
        await logLastConvItem(sess.conversationId_chat, "CONV:chat");

        await persistConversationLog(sess);

        res.json({ ok: true, assistant: greeting.message, ...audio });
    } catch (error) {
        log.error("UPLOAD", `failed: ${error.message}`);
        res.status(500).json({ error: "Erro ao processar arquivo com a IA" });
    }
});

// ============================================================================
// GET /s/:submissionToken/audio/:turnId
// Serve o áudio do entrevistador a partir do cache em memória.
// 404 se o turno foi evictado (cache LRU).
// ============================================================================
router.get("/s/:submissionToken/audio/:turnId", requireSubmissionToken, requireNotFinalized, (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(404).json({ error: "session not found" });
    const buffer = sess.audioCache?.get(String(req.params.turnId));
    if (!buffer) return res.status(404).json({ error: "audio expired or not found" });
    res.type("audio/mpeg");
    res.send(buffer);
});

// ============================================================================
// POST /s/:submissionToken/chat
// ============================================================================
router.post("/s/:submissionToken/chat", requireSubmissionToken, requireNotFinalized, requireWithinBudget, audioUpload.single("audio"), async (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(400).json({ error: "call /start first" });
    // O /upload move a sessão de "awaiting_upload" para "intro" e dispara
    // sess.interviewPreparation (uploads de arquivo + vector store + plan +
    // documentMap) em paralelo com a saudação. Durante intro, nada disso é
    // necessário — o IntroductionAgent só usa o YAML do entrevistador.
    if (sess.currentPhase === "awaiting_upload") {
        return res.status(400).json({ error: "envie o trabalho (PDF) antes de iniciar a conversa" });
    }

    // Coerência de modo: se a sessão é áudio, espera áudio; se é texto,
    // espera texto. Sem mistura no mesmo turno.
    const isAudioMode = sess.interactionMode === "audio";
    const hasAudio = !!req.file;
    if (isAudioMode && !hasAudio) {
        return res.status(400).json({ error: "esta entrevista está em modo áudio — envie uma gravação" });
    }
    if (!isAudioMode && hasAudio) {
        return res.status(400).json({ error: "esta entrevista está em modo texto — envie uma mensagem escrita" });
    }

    let message;
    // Duração da mensagem de voz do aluno (segundos). Em modo texto fica null.
    // Probada do buffer original antes do STT — não depende do shape do response.
    let studentAudioDurationSec = null;
    // Logprobs por token do STT, consumidos pelo pré-gate de inteligibilidade.
    // Em modo texto fica null e o gate é no-op.
    let studentAudioLogprobs = null;
    if (hasAudio) {
        try {
            studentAudioDurationSec = await getAudioDurationSeconds(
                req.file.buffer,
                req.file.mimetype || null,
            );
            const sttResult = await meteredStt(
                { ...sessionMeterCtx(sess), model: STT_MODEL },
                () => transcribeAudio(openai, STT_MODEL, req.file.buffer, req.file.originalname || "audio.webm")
            );
            message = sttResult.text;
            studentAudioLogprobs = sttResult.logprobs ?? null;
        } catch (err) {
            log.error("CHAT", `STT failed: ${err.message}`);
            return res.status(400).json({ error: "transcription_failed", detail: "Não consegui entender o áudio. Tente gravar de novo." });
        }
    } else {
        message = (req.body?.message || "").toString();
    }
    if (!message) return res.status(400).json({ error: "empty message" });

    const persist = () => persistConversationLog(sess);

    // ------------------------------------------------------------------
    // Pré-gate de inteligibilidade (modo áudio). Roda ANTES do bloco intro
    // ou triagem — se o áudio veio com trechos ininteligíveis (decidido por
    // lib/audioIntelligibility.js sobre os logprobs do STT), o entrevistador
    // pede repetição ou faz a virada de roleplay (give_up) na N-ésima vez. A
    // mensagem do aluno é descartada (registrada apenas como intervenção no
    // log do professor); o turno NÃO avança.
    // ------------------------------------------------------------------
    if (hasAudio && AUDIO_INTELLIGIBILITY.enabled && studentAudioLogprobs) {
        const gateResult = await runAudioIntelligibilityGate({
            sess,
            transcript: message,
            logprobs: studentAudioLogprobs,
            persist,
        });
        if (gateResult.gated) return res.json(gateResult.response);
    }

    // ------------------------------------------------------------------
    // Intro — roteiro de abertura, despachado por introStep. Cada beat é um
    // round-trip normal (uma fala do entrevistador, uma do aluno):
    //   awaiting_name  → aluno mandou o nome → beat present_self (cumprimenta,
    //                    fala de si, pede um "ok") → introStep = awaiting_ok.
    //   awaiting_ok    → aluno mandou o "ok" → beat begin + 1ª pergunta do
    //                    plano → phase = interviewing.
    // Triage/sufficiency/relevance não rodam aqui.
    // ------------------------------------------------------------------
    if (sess.currentPhase === "intro") {
        // Push da mensagem do aluno (comum aos dois beats).
        sess.introLog.push({
            role: "user",
            content: message,
            at: new Date().toISOString(),
            audio_duration_seconds: studentAudioDurationSec,
        });
        sess.conv_chat.push({ role: "user", content: message });
        sess.conv_eval.push({ role: "user", content: message, metadata: { phase: "intro", timestamp: Date.now() } });
        sess.history = sess.conv_chat;
        try {
            await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
            await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "user", content: message }] });
        } catch (err) {
            log.error("CHAT", `remote write (intro user) failed: ${err.message}`);
        }

        // ---- Beat present_self: o aluno disse o nome. ----
        if (sess.introStep !== "awaiting_ok") {
            let intro;
            try {
                intro = await introductionAgent.evaluate({
                    step: "present_self",
                    interviewerYamlText: sess.interviewerYamlText ?? "",
                    persona: sess.interviewerPersona,
                    introHistory: sess.introLog.slice(0, -1),  // sem a mensagem recém-empurrada
                    studentMessage: message,
                    meterCtx: sessionMeterCtx(sess),
                    interactionMode: sess.interactionMode,
                });
            } catch (err) {
                log.error("AGENT:Introduction", `present_self failed, using fallback: ${err.message}`);
                intro = { message: "Prazer em falar contigo. Quando você estiver pronto, me dá um ok que a gente começa.", student_name: null, reason: "agent_failed" };
            }

            if (intro.student_name) sess.studentName = intro.student_name;
            sess.introStep = "awaiting_ok";

            const audio = await attachAudio(sess, intro.message);
            sess.introLog.push({
                role: "assistant",
                content: intro.message,
                at: new Date().toISOString(),
                audio_duration_seconds: audio.audio_duration_seconds ?? null,
            });
            sess.conv_chat.push({ role: "assistant", content: intro.message });
            sess.conv_eval.push({ role: "assistant", content: intro.message, metadata: { phase: "intro", student_name: sess.studentName ?? null, timestamp: Date.now() } });
            sess.history = sess.conv_chat;
            try {
                await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: intro.message }] });
                await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: intro.message }] });
            } catch (err) {
                log.error("CHAT", `remote write (intro present_self) failed: ${err.message}`);
            }
            log.info("CHAT", `intro present_self${sess.studentName ? ` name="${sess.studentName}"` : ""} ${log.preview(intro.message, 120)}`);
            await logLastConvItem(sess.conversationId_chat, "CONV:chat");
            persist();
            return res.json({ channel: "chat", assistant: intro.message, ...audio });
        }

        // ---- Beat begin: o aluno deu o "ok". Garante o plano e transiciona. ----
        if (!sess.interviewPlan) {
            try { await sess.interviewPreparation; }
            catch (err) { log.error("INTRO", `interviewPreparation failed: ${err.message}`); }

            if (!sess.interviewPlan && sess.interviewPreparationError && sess.preparationInputs) {
                log.info("INTRO", `retrying interview preparation after failure: ${sess.interviewPreparationError.message}`);
                startInterviewPreparation(sess);
                try { await sess.interviewPreparation; }
                catch (err) { log.error("INTRO", `interviewPreparation retry failed: ${err.message}`); }
            }

            if (!sess.interviewPlan) {
                const detail = sess.interviewPreparationError?.message || "plano indisponível";
                log.error("INTRO", `begin aborted: ${detail}`);
                return res.status(500).json({ error: "Falha ao preparar a entrevista. Tente novamente.", detail });
            }
        }

        let begin;
        try {
            begin = await introductionAgent.evaluate({
                step: "begin",
                interviewerYamlText: sess.interviewerYamlText ?? "",
                persona: sess.interviewerPersona,
                introHistory: sess.introLog.slice(0, -1),
                studentMessage: message,
                studentName: sess.studentName,
                meterCtx: sessionMeterCtx(sess),
                interactionMode: sess.interactionMode,
            });
        } catch (err) {
            log.error("AGENT:Introduction", `begin failed, using fallback: ${err.message}`);
            begin = { message: "Então vamos começar.", reason: "agent_failed" };
        }

        const firstPlanQuestion = sess.interviewPlan.questions[0];
        const combined = `${begin.message}\n\n${firstPlanQuestion.question}`;

        const audio = await attachAudio(sess, combined);
        const transitionAudioSec = audio.audio_duration_seconds ?? null;

        sess.introLog.push({
            role: "assistant",
            content: begin.message,
            at: new Date().toISOString(),
            audio_duration_seconds: transitionAudioSec,
        });
        sess.introTransitionedAt = new Date().toISOString();
        const firstTurn = turnFromPlanQuestion(0, firstPlanQuestion);
        firstTurn.question_audio_duration_seconds = transitionAudioSec;
        sess.turnLog.push(firstTurn);
        sess.questionIndex = 1;
        sess.currentPhase = "interviewing";
        sess.introStep = "done";

        sess.conv_chat.push({ role: "assistant", content: combined });
        sess.conv_eval.push({
            role: "assistant",
            content: combined,
            metadata: { phase: "intro_to_interviewing", documentMap: sess.documentMap, interviewPlan: sess.interviewPlan, timestamp: Date.now() },
        });
        sess.history = sess.conv_chat;
        try {
            await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: combined }] });
            await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: combined }] });
        } catch (err) {
            log.error("CHAT", `remote write (intro begin) failed: ${err.message}`);
        }
        log.info("CHAT", `intro begin + first plan question ${log.preview(combined, 160)}`);
        await logLastConvItem(sess.conversationId_chat, "CONV:chat");
        persist();
        return res.json({ channel: "chat", assistant: combined, phase: "interviewing", ...audio });
    }

    const planHasMoreQuestions = sess.questionIndex < (sess.interviewPlan?.questions?.length ?? 0);
    const currentTurn = sess.turnLog?.[sess.turnLog.length - 1];

    // Carries the sufficiency-generated transition phrase from the triage block
    // down to the normal flow (where the next plan question is assembled). Stays
    // null when sufficiency wasn't run, errored out, or chose follow_up.
    let acceptedTransitionPhrase = null;

    // ------------------------------------------------------------------
    // Triage + sufficiency phase. All four agents are launched in parallel
    // as soon as the message arrives. Triage (3 fast agents) decides whether
    // the message should be intercepted as scope/off-topic/meta. Sufficiency
    // (1 reasoning agent) decides whether the answer is complete and coherent
    // enough to advance — but its result is only consumed when no triage
    // guardrail wins. If a guardrail wins, sufficiency is best-effort
    // cancelled via AbortSignal and its outcome is ignored.
    //
    // Both phases are gated by "plan still has a pending question and the
    // current turn is awaiting an answer".
    // ------------------------------------------------------------------
    if (planHasMoreQuestions && currentTurn && currentTurn.answer == null) {
        const triageContext = {
            interviewerYamlText: sess.interviewerYamlText ?? "",
            currentTurn,
            studentMessage: message,
            vectorStoreId: sess.vectorStoreId,
            meterCtx: sessionMeterCtx(sess),
            interactionMode: sess.interactionMode,
            studentName: sess.studentName ?? null,
        };

        const sufficiencyAbort = new AbortController();
        const sufficiencyPromise = answerSufficiencyAgent.evaluate({
            interviewerYamlText: sess.interviewerYamlText ?? "",
            currentTurn,
            turnLog: sess.turnLog,
            studentMessage: message,
            vectorStoreId: sess.vectorStoreId,
            signal: sufficiencyAbort.signal,
            meterCtx: sessionMeterCtx(sess),
            interactionMode: sess.interactionMode,
            studentName: sess.studentName ?? null,
        }).catch(err => {
            const aborted = err?.name === "APIUserAbortError"
                || err?.constructor?.name === "APIUserAbortError"
                || /aborted/i.test(err?.message ?? "");
            if (aborted) {
                log.info("AGENT:AnswerSufficiency", "aborted (triage winner)");
                return { aborted: true };
            }
            log.error("AGENT:AnswerSufficiency", `failed, defaulting to accept: ${err.message}`);
            return { aborted: false, decision: "accept", issue: "none", reason: "agent_failed", follow_up_question: null };
        });

        const fallback = (type, channel) => (err) => {
            log.error(`AGENT:${type}`, `failed, scoring as 0: ${err.message}`);
            return { type, channel, intensity: 0, assistant_response: "", rationale: `agent failed: ${err.message}` };
        };
        const [scopeResult, offTopicResult, metaResult] = await Promise.all([
            scopeClarificationAgent.evaluate(triageContext).catch(fallback("scope_clarification", "chat")),
            offTopicRedirectAgent.evaluate(triageContext).catch(fallback("off_topic_redirect", "chat")),
            metaInterventionAgent.evaluate(triageContext).catch(fallback("meta", "modal")),
        ]);
        const triageResults = [scopeResult, offTopicResult, metaResult];
        const scores = {
            scope_clarification: scopeResult.intensity,
            off_topic_redirect: offTopicResult.intensity,
            meta: metaResult.intensity,
        };
        log.info("TRIAGE", `scores scope=${scores.scope_clarification} off_topic=${scores.off_topic_redirect} meta=${scores.meta}`);

        const winner = pickTriageWinner(triageResults);
        if (winner) {
            sufficiencyAbort.abort();
            log.info("TRIAGE", `winner=${winner.type} intensity=${winner.intensity} channel=${winner.channel}`);
            // TTS antes do push para anexar a duração ao intervention.
            const audio = await attachAudio(sess, winner.assistant_response);
            const intervention = {
                type: winner.type,
                student_message: message,
                assistant_response: winner.assistant_response,
                intensity: winner.intensity,
                channel: winner.channel,
                scores,
                at: new Date().toISOString(),
                student_audio_duration_seconds: studentAudioDurationSec,
                assistant_audio_duration_seconds: audio.audio_duration_seconds ?? null,
            };
            if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
            currentTurn.interventions.push(intervention);

            if (winner.channel === "modal") {
                // Meta intervention: keep the student message OUT of conv_chat (local
                // and remote). Record into conv_eval for audit so the final evaluator
                // still sees the exchange if needed.
                sess.conv_eval.push({ role: "user", content: message, metadata: { triage: "meta", dropped_from_chat: true, timestamp: Date.now() } });
                sess.conv_eval.push({ role: "assistant", content: winner.assistant_response, metadata: { triage: "meta", channel: "modal", timestamp: Date.now() } });
                try {
                    await openai.conversations.items.create(sess.conversationId_eval, {
                        items: [
                            { role: "user", content: message },
                            { role: "assistant", content: winner.assistant_response },
                        ],
                    });
                } catch (err) {
                    log.error("CHAT", `remote eval write (meta) failed: ${err.message}`);
                }
                persist();
                return res.json({
                    channel: "modal",
                    assistant_response: winner.assistant_response,
                    restore_input: message,
                    ...audio,
                });
            }

            // Chat-channel intervention (scope_clarification / off_topic_redirect):
            // student message and agent response DO flow through conv_chat.
            sess.conv_chat.push({ role: "user", content: message });
            sess.conv_chat.push({ role: "assistant", content: winner.assistant_response });
            sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
            sess.conv_eval.push({ role: "assistant", content: winner.assistant_response, metadata: { triage: winner.type, timestamp: Date.now() } });
            sess.history = sess.conv_chat;
            try {
                await openai.conversations.items.create(sess.conversationId_chat, {
                    items: [
                        { role: "user", content: message },
                        { role: "assistant", content: winner.assistant_response },
                    ],
                });
                await openai.conversations.items.create(sess.conversationId_eval, {
                    items: [
                        { role: "user", content: message },
                        { role: "assistant", content: winner.assistant_response },
                    ],
                });
            } catch (err) {
                log.error("CHAT", `remote write (triage=${winner.type}) failed: ${err.message}`);
            }
            log.info("CHAT", `user (triaged=${winner.type}) ${log.preview(message, 140)}`);
            await logLastConvItem(sess.conversationId_chat, "CONV:chat");
            persist();
            return res.json({ channel: "chat", assistant: winner.assistant_response, ...audio });
        }

        // No triage winner — sufficiency now blocks the move to the next turn.
        const sufficiency = await sufficiencyPromise;
        if (sufficiency.decision === "follow_up" && sufficiency.follow_up_question) {
            log.info("AGENT:AnswerSufficiency", `follow_up issue=${sufficiency.issue}`);
            // TTS antes do push para anexar a duração ao intervention.
            const audio = await attachAudio(sess, sufficiency.follow_up_question);
            const intervention = {
                type: "follow_up",
                issue: sufficiency.issue,
                student_message: message,
                assistant_response: sufficiency.follow_up_question,
                channel: "chat",
                reason: sufficiency.reason,
                diminishing_returns_check: sufficiency.diminishing_returns_check ?? null,
                at: new Date().toISOString(),
                student_audio_duration_seconds: studentAudioDurationSec,
                assistant_audio_duration_seconds: audio.audio_duration_seconds ?? null,
            };
            if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
            currentTurn.interventions.push(intervention);

            sess.conv_chat.push({ role: "user", content: message });
            sess.conv_chat.push({ role: "assistant", content: intervention.assistant_response });
            sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
            sess.conv_eval.push({ role: "assistant", content: intervention.assistant_response, metadata: { intervention: "follow_up", issue: sufficiency.issue, timestamp: Date.now() } });
            sess.history = sess.conv_chat;
            try {
                await openai.conversations.items.create(sess.conversationId_chat, {
                    items: [
                        { role: "user", content: message },
                        { role: "assistant", content: intervention.assistant_response },
                    ],
                });
                await openai.conversations.items.create(sess.conversationId_eval, {
                    items: [
                        { role: "user", content: message },
                        { role: "assistant", content: intervention.assistant_response },
                    ],
                });
            } catch (err) {
                log.error("CHAT", `remote write (follow_up) failed: ${err.message}`);
            }
            log.info("CHAT", `user (follow_up=${sufficiency.issue}) ${log.preview(message, 140)}`);
            await logLastConvItem(sess.conversationId_chat, "CONV:chat");
            persist();
            return res.json({ channel: "chat", assistant: intervention.assistant_response, ...audio });
        }
        // accept (or aborted/failed defaulting to accept). Capture the transition
        // phrase generated by sufficiency so the normal flow can prepend it to
        // the next plan question.
        if (sufficiency.decision === "accept" && sufficiency.transition_phrase) {
            acceptedTransitionPhrase = sufficiency.transition_phrase;
        }
    }

    // ------------------------------------------------------------------
    // Normal flow (no triage intervention). Student message becomes the
    // answer to the current turn; next plan question (or the wrap-up
    // sentinel if the plan is exhausted) is returned.
    // ------------------------------------------------------------------
    sess.conv_chat.push({ role: "user", content: message });
    sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
    sess.history = sess.conv_chat;

    if (currentTurn && currentTurn.answer == null) {
        currentTurn.answer = message;
        currentTurn.answered_at = new Date().toISOString();
        currentTurn.answer_audio_duration_seconds = studentAudioDurationSec;
        if (acceptedTransitionPhrase) {
            currentTurn.transition_to_next = acceptedTransitionPhrase;
        }
        persist();
    }

    try {
        await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
        await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "user", content: message }] });

        log.info("CHAT", `user #${sess.questionIndex} ${log.preview(message, 140)}`);
        await logLastConvItem(sess.conversationId_chat, "CONV:chat");

        // Relevance pass: before serving the next planned question, ask whether
        // it still makes sense given the conversation so far. Skip-loops past
        // questions whose substance is already covered. Bounded to keep a
        // misbehaving agent from emptying the rest of the plan.
        let relevanceSkips = 0;
        while (sess.questionIndex < sess.interviewPlan.questions.length && relevanceSkips < MAX_RELEVANCE_SKIPS) {
            const candidate = sess.interviewPlan.questions[sess.questionIndex];
            let decision;
            try {
                decision = await questionRelevanceAgent.evaluate({
                    interviewerYamlText: sess.interviewerYamlText ?? "",
                    turnLog: sess.turnLog,
                    candidateQuestion: candidate,
                    meterCtx: sessionMeterCtx(sess),
                });
            } catch (err) {
                log.error("AGENT:QuestionRelevance", `failed, defaulting to ask: ${err.message}`);
                decision = { decision: "ask", reason: "agent_failed" };
            }
            if (decision.decision === "skip") {
                if (!Array.isArray(sess.skippedQuestions)) sess.skippedQuestions = [];
                sess.skippedQuestions.push({
                    plan_id: candidate?.id ?? null,
                    question: candidate?.question ?? "",
                    rationale: candidate?.rationale ?? null,
                    reason: decision.reason,
                    at: new Date().toISOString(),
                });
                log.info("RELEVANCE", `skip plan_id=${candidate?.id} reason=${log.preview(decision.reason, 120)}`);
                sess.questionIndex++;
                relevanceSkips++;
                persist();
                continue;
            }
            log.info("RELEVANCE", `ask plan_id=${candidate?.id}`);
            break;
        }
        if (relevanceSkips >= MAX_RELEVANCE_SKIPS) {
            log.error("RELEVANCE", `cap reached (${MAX_RELEVANCE_SKIPS}); forcing ask on questionIndex=${sess.questionIndex}`);
        }

        let assistantResponse;
        let nextTurnRef = null;
        if (sess.questionIndex < sess.interviewPlan.questions.length) {
            const planQuestion = sess.interviewPlan.questions[sess.questionIndex];
            const nextQuestion = planQuestion?.question;
            if (!nextQuestion) {
                throw new Error("Question not found in interview plan");
            }
            const phrase = acceptedTransitionPhrase || "Próxima pergunta.";
            assistantResponse = `${phrase}\n\n${nextQuestion}`;
            nextTurnRef = turnFromPlanQuestion(sess.turnLog.length, planQuestion);
            sess.turnLog.push(nextTurnRef);
            sess.questionIndex++;
            persist();
            log.info("TURN", `q#${sess.questionIndex} (sequential from plan)${acceptedTransitionPhrase ? " with sufficiency phrase" : " with default phrase"}`);
        } else {
            assistantResponse = "Obrigado pelas respostas. Acredito que já tenho informações suficientes para avaliar. A entrevista está concluída.";
            sess.currentPhase = "finalizing";
            log.info("TURN", `all questions covered or completed, finalizing`);
        }

        sess.conv_chat.push({ role: "assistant", content: assistantResponse });
        sess.conv_eval.push({ role: "assistant", content: assistantResponse, metadata: { timestamp: Date.now() } });
        sess.history = sess.conv_chat;

        await openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: assistantResponse }] });
        await openai.conversations.items.create(sess.conversationId_eval, { items: [{ role: "assistant", content: assistantResponse }] });

        log.info("CHAT", `assistant ${log.preview(assistantResponse, 140)}`);
        await logLastConvItem(sess.conversationId_chat, "CONV:chat");

        const audio = await attachAudio(sess, assistantResponse);
        // Persiste a duração do TTS no novo turno (quando há próximo turno do plano)
        // — essa é a duração do áudio da pergunta + frase de transição.
        if (nextTurnRef) {
            nextTurnRef.question_audio_duration_seconds = audio.audio_duration_seconds ?? null;
            persist();
        }
        res.json({ channel: "chat", assistant: assistantResponse, phase: sess.currentPhase, ...audio });
    } catch (error) {
        log.error("CHAT", `failed: ${error.message}`);
        res.status(500).json({ error: "Erro ao processar mensagem" });
    }
});

// ============================================================================
// POST /s/:submissionToken/finalize
// ----------------------------------------------------------------------------
// Encerra a entrevista definitivamente, gravando o motivo e o comentário
// opcional do aluno. Após esta chamada, /chat, /upload e /audio devolvem 410
// (via requireNotFinalized). Aceita dois cenários:
//   - completion_reason="complete": finalização natural após o plano se esgotar
//     (frontend dispara isto quando o aluno submete o formulário de comentário
//     na tela mostrada depois da mensagem de encerramento do entrevistador).
//   - completion_reason="give_up": aluno clicou em "Desistir" durante a
//     entrevista.
// O endpoint não é idempotente em sentido estrito: chamar duas vezes
// sobrescreve o comentário e o reason. Em prática o frontend só chama uma vez
// porque depois disto a tela vai para "Entrevista registrada".
// ============================================================================
const MAX_COMMENT_LEN = 2000;
router.post("/s/:submissionToken/finalize", requireSubmissionToken, express.json({ limit: "16kb" }), async (req, res) => {
    const reason = String(req.body?.completion_reason ?? "");
    if (reason !== "complete" && reason !== "give_up") {
        return res.status(400).json({ error: "completion_reason deve ser 'complete' ou 'give_up'" });
    }
    if (req.submission.completion_reason) {
        return res.status(409).json({ error: "entrevista já finalizada", completion_reason: req.submission.completion_reason });
    }
    const rawComment = req.body?.comment;
    const comment = typeof rawComment === "string" ? rawComment.slice(0, MAX_COMMENT_LEN) : null;
    try {
        await db.finalizeSubmission(req.submission.id, comment, reason);
        // Tenta atualizar a sessão em memória pra evitar uma janela em que ela
        // possa parecer ainda "viva". Tolerante a sess inexistente — sem sessão
        // em memória, os endpoints já estão bloqueados pelo middleware via DB.
        const sess = SESSIONS.get(req.submission.submission_token);
        if (sess) {
            sess.conversationCompleted = true;
            sess.currentPhase = "finalized";
        }
        log.info("SUBMISSION", `finalized token=${req.submission.submission_token} reason=${reason} has_comment=${!!comment}`);
        res.json({ ok: true, completion_reason: reason });
    } catch (err) {
        log.error("SUBMISSION", `finalize failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "falha ao finalizar entrevista", detail: err.message });
    }
});

export default router;

// Rotas do aluno (auth via submission_token Bearer).
// Cinco endpoints: /start, /upload, /audio/:turnId, /chat, /finalize +
// /intro/advance.
//
// O handler /chat tem dois fluxos:
//   - Fase intro: roteiro determinístico de 3 falas (IntroductionAgent).
//   - Fase interviewing: UMA chamada de raciocínio (SuperOrchestratorAgent)
//     decide a próxima ação (ask / follow_up / meta_modal / hint / finalize /
//     ask_repeat). Substituiu triagem×3 + sufficiency + relevance + composição
//     do legado. Guardrails (MAX_TURNS, finalize precoce) ficam no código,
//     não no agente.
//
// Pré-gate de áudio (algoritmo sobre logprobs do STT + AudioIntelligibilityAgent
// só para fraseiar) roda antes do super-orquestrador no modo áudio.

import express from "express";
import multer from "multer";
import { requireSubmissionToken, requireWithinBudget, requireNotFinalized } from "../lib/middleware.js";
import { exceedsPageLimit, MAX_PDF_PAGES } from "../lib/pdfPages.js";
import * as db from "../lib/db.js";
import { openai, clientForWork } from "../lib/openaiClient.js";
import { transcribeAudio, synthesizeSpeech, AudioCache } from "../lib/audio.js";
import { getAudioDurationSeconds } from "../lib/audioMeta.js";
import { meteredStt } from "../lib/billing.js";
import { decideChatDedup, markChatDone, abortChatDedup } from "../lib/chatDedup.js";
import { scheduleKeepalive, cancelKeepalive } from "../lib/cacheKeepalive.js";
import { STT_MODEL, TTS_MODEL, AUDIO_INTELLIGIBILITY, ACOUSTIC, DEFAULT_QUESTION_COUNT } from "../lib/config.js";
import { pickPersona } from "../lib/personas.js";
import { deleteConversationLog } from "../lib/conversationLog.js";
import { classifyAudio } from "../lib/audioIntelligibility.js";
import { classifyAcoustic, combineTiers } from "../lib/acousticGate.js";
import { REVIEW_WINDOW_DAYS, reviewWindowState } from "../lib/reviewWindow.js";
import { scoreCalibration } from "../lib/speechCalib.js";
import {
    introductionAgent,
    audioIntelligibilityAgent,
    superOrchestratorAgent,
} from "../lib/agents.js";
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
    attachAudioChunks,
    maybeRebuildPendingQuestionAudio,
    initOrResumeSession,
    startInterviewPreparation,
    maybeKickOffPregeneration,
    pregenSnapshot,
} from "../lib/sessionLifecycle.js";
import { attachNarratorAudio } from "../lib/narrator.js";
import { putAudio, audioKeyFor, extFromMimetype, streamAudio } from "../lib/audioStore.js";
import { videoMandatory } from "../lib/proctor.js";
import { runProctorAuto } from "../lib/proctorAuto.js";
import log from "../lib/logger.js";
import { generateStudentAnswer, STUDENT_PROFILES } from "../lib/studentSimulator.js";

// Guardrails de turno do super-orquestrador. Antes fixos (30/5); agora derivam
// do número de perguntas planejadas (works.question_count, materializado no
// plano da sessão). Cap duro força finalize automático independentemente do que
// o agente decidir (protege contra agente que não finaliza nunca); piso bloqueia
// finalize precoce (exceto finalize_reason="student_disengaged"). As fórmulas
// reproduzem 30/5 no antigo default de 10 perguntas.
//   cap  = nº de perguntas × 3   (folga para follow-ups e perguntas espontâneas)
//   piso = ceil(nº de perguntas / 2)
// O nº vem do plano persistido (sobrevive a restart). Fallback defensivo só se o
// plano ainda não existir — impossível na fase interviewing, onde isto roda.
function plannedQuestionCount(sess) {
    return sess.interviewPlan?.questions?.length ?? DEFAULT_QUESTION_COUNT;
}
function maxTurnsFor(sess) {
    return plannedQuestionCount(sess) * 3;
}
function minTurnsBeforeFinalizeFor(sess) {
    return Math.ceil(plannedQuestionCount(sess) / 2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A Conversations API da OpenAI serializa operações por conversa: dois turnos
// em sequência rápida podem colidir e devolver 400 "Another process is currently
// operating on this conversation. Please retry in a few seconds." Antes, esse
// erro caía direto no fallback ask_repeat, que pedia ao aluno para REDIGITAR a
// resposta por causa de uma corrida transitória de backend. Aqui detectamos esse
// erro específico e retentamos com backoff antes de degradar — a própria API diz
// "retry in a few seconds". Só este erro é retentado; qualquer outro propaga.
function isConversationLockError(err) {
    const m = err && err.message ? String(err.message) : "";
    return m.includes("Another process is currently operating on this conversation");
}

async function evaluateWithConversationLockRetry(fn, { retries = 3, baseDelayMs = 1200 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isConversationLockError(err) || attempt === retries) throw err;
            const delay = baseDelayMs * (attempt + 1);
            log.warn("SUPER_ORQ", `conversation lock (tentativa ${attempt + 1}/${retries}); retry em ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

// Persiste a finalização no banco no MOMENTO em que o servidor decide encerrar
// (finalize do orquestrador ou cap duro de turnos). O servidor é a fonte de
// verdade: sem gravar completion_reason aqui, o frontend assumia "server já
// finalizou" e ia direto pra revisão, mas /review devolvia 409 (não carregava a
// conversa) e, no refresh, /start retomava a entrevista — em áudio, reexibindo o
// último áudio do entrevistador, sem acesso ao campo de comentário. Idempotente
// na prática: requireNotFinalized garante que /chat só roda com a submissão
// ainda aberta. Falha de escrita é logada, não derruba a despedida.
async function persistFinalization(req, completionReason) {
    try {
        // Gate de vídeo obrigatório: quando o proctoring é exigido e ainda não há
        // vídeo, a submissão fica 'awaiting_video' (não 'complete') até o upload
        // chegar. give_up sempre conclui. Tokens de teste ficam isentos.
        const mandatory = videoMandatory(req.work) && req.submission.is_test !== true;
        await db.finalizeWithVideoGate(req.submission.id, { mandatory, reason: completionReason });
    } catch (err) {
        log.error("SUBMISSION", `finalize persist failed token=${req.submission.submission_token} reason=${completionReason}: ${err.message}`);
    }
}
// Tamanho máximo da mensagem do aluno por turno (texto ou transcrição de
// áudio). Defesa contra prompt-injection que tenta confundir o reasoning
// model com payloads longos. 4000 chars cobre ~600-800 palavras —
// muito além do que cabe num turno legítimo de entrevista oral.
const MAX_STUDENT_MESSAGE_CHARS = 4000;

// Janela de revisão pós-encerramento (LGPD self-access) — REVIEW_WINDOW_DAYS +
// reviewWindowState vivem em lib/reviewWindow.js, compartilhados com a prova oral.

// Arquiva o buffer de áudio do aluno (best-effort) — sobe pro Object Storage
// e grava metadados no Postgres. NUNCA lança. Se o storage estiver indisponível
// ou falhar, loga e segue — a entrevista não pode quebrar por isso.
// audio_idx é sequencial por submission, batendo com a ordem dos uploads de
// áudio do aluno; isso permite o painel do professor casar áudio com fala na
// conv_chat pela ordem.
async function archiveStudentAudio({ submissionId, submissionToken, buffer, mimetype, durationS, turnIndex = null }) {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    try {
        const audioIdx = await db.nextAudioIdxForSubmission(submissionId);
        const ext = extFromMimetype(mimetype);
        const key = audioKeyFor(submissionToken, audioIdx, ext);
        const result = await putAudio({ key, buffer, mimetype });
        if (!result.stored) {
            log.info("AUDIO_STORE", `put no-op submission=${submissionToken} idx=${audioIdx} reason=${result.reason}`);
            return null;
        }
        await db.recordStudentAudioArtifact({
            submissionId,
            audioIdx,
            turnIndex,
            objectKey: result.key,
            mimetype,
            byteSize: result.byte_size ?? buffer.length,
            durationS,
            sha256: result.sha256,
        });
        return { audioIdx, objectKey: result.key };
    } catch (err) {
        log.error("AUDIO_STORE", `archiveStudentAudio failed submission=${submissionToken}: ${err.message}`);
        return null;
    }
}

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
// Parse de campo de formulário numérico (multipart → string). Devolve número
// finito ou null (ausente / não-numérico / NaN / Infinity).
function numOrNull(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// `reason` ("logprob" | "acoustic") ajusta o texto da Dica fora do roleplay:
// logprob destaca trechos transcritos; acústico fala de barulho de fundo.
async function runAudioRepeat({ sess, transcript, spans, aggregate, persist, reason = "logprob" }) {
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
            studentGenderHint: sess.studentGenderHint ?? null,
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

    // Retém a transcrição (marcada baixa-confiança) no contexto do orquestrador —
    // NÃO descarta. No próximo turno, com a repetição, ele reconstrói o sentido e
    // o aluno não precisa repetir tudo. Não é a resposta do turno (currentTurn.answer
    // só é setado quando uma tentativa passa pelo orquestrador).
    const markedStudent = `[transcrição de áudio com baixa confiança] ${transcript}`;
    sess.conv_chat.push({ role: "user", content: markedStudent });
    sess.conv_eval.push({ role: "user", content: markedStudent, metadata: { audio_low_confidence: true, timestamp: Date.now() } });
    // Empurra a fala do entrevistador (pedido de repetição) no conv.
    sess.conv_chat.push({ role: "assistant", content: phrased.message });
    sess.conv_eval.push({
        role: "assistant",
        content: phrased.message,
        metadata: { intervention: "audio_intelligibility", mode, attempt, timestamp: Date.now() },
    });
    sess.history = sess.conv_chat;
    try {
        await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: markedStudent }] });
        await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: phrased.message }] });
    } catch (err) {
        log.error("CHAT", `remote write (audio repeat) failed: ${err.message}`);
    }
    await logLastConvItem(sess.conversationId_chat, "CONV:chat", sess.openai);

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
        reason: phrased.reason || (reason === "acoustic"
            ? `gate acústico (barulho de fundo / SNR baixo); tentativa ${attempt}/${max}`
            : `algoritmo detectou ${spans.length} trecho(s) de baixa confiança; tentativa ${attempt}/${max}`),
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

    // Dica (fora do roleplay) aparece SEMPRE que o áudio é barrado — repetição
    // ou desistência — e inclui a transcrição da fala do aluno com os trechos
    // que não ficaram claros destacados, para ele saber exatamente o que o
    // entrevistador não entendeu. É a própria fala do aluno (não a pergunta do
    // entrevistador), então não há preocupação de anti-cola.
    const unclear = spans.map(s => s.text);
    const isAcoustic = reason === "acoustic";
    let hint;
    if (mode === "give_up") {
        hint = {
            kind: "audio_give_up",
            title: "Problemas com o áudio?",
            body: isAcoustic
                ? "O entrevistador não está conseguindo te ouvir por causa do barulho de fundo. Procure um ambiente mais silencioso (ou reduza o som ao redor), aproxime o microfone e grave de novo. Se achar que o problema é do sistema, use o botão \"Desistir da entrevista\" no topo, deixe um comentário descrevendo o que aconteceu, e peça outro link ao seu professor."
                : "O entrevistador não está conseguindo te entender. Veja abaixo como o seu áudio foi transcrito — os trechos destacados não ficaram claros. Você pode ajustar o microfone (ou mudar para um ambiente mais silencioso) e gravar de novo. Se achar que o problema é do sistema, use o botão \"Desistir da entrevista\" no topo, deixe um comentário descrevendo o que aconteceu, e peça outro link ao seu professor.",
            transcript,
            unclear,
        };
    } else if (isAcoustic) {
        hint = {
            kind: "audio_repeat",
            title: "Tem bastante barulho de fundo no seu áudio",
            body: "O som ao redor estava alto e o entrevistador não conseguiu te ouvir bem. Procure um lugar mais silencioso (ou reduza a fonte de barulho), aproxime o microfone e grave a sua resposta de novo, com calma.",
            transcript,
            unclear,
        };
    } else {
        hint = {
            kind: "audio_repeat",
            title: "O entrevistador não entendeu parte do que você disse",
            body: "Veja abaixo como o seu áudio foi transcrito — os trechos destacados não ficaram claros. Tente gravar de novo, com calma, reforçando essas partes.",
            transcript,
            unclear,
        };
    }

    return {
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

// Dica não-bloqueante do caso "avisar": a resposta do aluno SEGUE normalmente
// (vai ao orquestrador, o entrevistador responde) e esta Dica aparece junto,
// destacando os trechos incertos — o aluno corrige se foi mal-entendido.
function buildAvisarDica(transcript, spans, reason = "logprob") {
    if (reason === "acoustic") {
        return {
            kind: "audio_warn",
            title: "Detectamos barulho de fundo no seu áudio",
            body: "O som ao redor estava um pouco alto. Eu segui com a resposta normalmente; se eu entendi algo errado, é só me corrigir na próxima — ou, se quiser, procure um lugar mais silencioso para as próximas respostas.",
            transcript,
            unclear: spans.map(s => s.text),
        };
    }
    return {
        kind: "audio_warn",
        title: "Parte do seu áudio pode ter saído mal",
        body: "Veja como o seu áudio foi transcrito — os trechos destacados podem ter saído errados. Eu segui com a resposta normalmente; se eu entendi algo errado, é só me corrigir na próxima.",
        transcript,
        unclear: spans.map(s => s.text),
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
// Vídeo do proctoring (entrevista): gravação contínua cam+mic, bitrate baixo (só
// revisão humana). Limite generoso para entrevistas longas.
const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// ============================================================================
// POST /s/:submissionToken/start
// ============================================================================
router.post("/s/:submissionToken/start", requireSubmissionToken, async (req, res) => {
    const token = req.submission.submission_token;

    // Entrevista já finalizada: o frontend roteia entre 3 estados:
    //   (a) review aberto (dentro da janela de 7d, sem comentário enviado)
    //   (b) review com comentário enviado (read-only, dentro da janela)
    //   (c) janela expirada → tela final encerrada
    // Aqui só sinalizamos os dados; o frontend chama GET /s/:t/review pra
    // carregar o conteúdo completo quando estiver em (a) ou (b).
    if (req.submission.completion_reason) {
        const win = reviewWindowState(req.submission);
        return res.json({
            work: { name: req.work.name, has_enunciado: !!req.work.assignment_pdf },
            submission: {
                status: req.submission.status,
                student_label: req.submission.student_label,
                completion_reason: req.submission.completion_reason,
                completed_at: req.submission.completed_at,
                comment_submitted: !!req.submission.student_comment,
            },
            session: {
                currentPhase: "finalized",
                finalized: true,
                review: {
                    eligible: win.eligible,
                    expired: win.expired,
                    deadline: win.deadline,
                },
            },
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
                        seed: req.work.work_token,
                    });
                }
            }
            log.info("SUBMISSION", `resume(mem) token=${token} phase=${sess.currentPhase} qn=${sess.questionCount} mode=${sess.interactionMode}`);
            // SESSIONS-hit em modo áudio também precisa do último áudio para tocar
            // (reload da aba). Reaproveita o buffer cacheado quando possível.
            pendingAudio = await maybeRebuildPendingQuestionAudio(sess);
            // Em awaiting_upload, garante pré-geração ativa (saudação + orientador).
            // Idempotente — se já feito ou em vôo com o snapshot atual, no-op.
            try { await maybeKickOffPregeneration(sess, req); }
            catch (err) { log.error("PREGEN", `kickoff(memhit) failed: ${err.message}`); }
        }

        // Re-sincroniza a expectativa de espontaneidade com a config atual do
        // trabalho (igual ao modo): vale para o aviso ao aluno no /start.
        // Fiscalização por vídeo já garante a integridade — não pedir "resposta de cabeça"
        // (a fala de espontaneidade não faz mais sentido e conflita com a câmera ligada).
        sess.expectSpontaneous = req.work.expect_spontaneous === true && req.work.proctoring_enabled !== true;

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
// Proctoring por vídeo (opt-in) — setup do aluno ANTES do chat
// ============================================================================
// Config para a tela de setup: se o trabalho tem proctoring ligado e a frase de
// calibração de fala (mesma coluna/lib da prova oral). Sem proctoring, o aluno vai
// direto para o chat (o frontend decide). Fail-open em tudo.
const MAX_CALIB_ATTEMPTS = 2;
const CALIB_ADVICE = "Fale em volume médio, num ritmo tranquilo (sem correr) e sem cortar o fim das palavras — assim a captação transcreve melhor a sua fala.";
router.get("/s/:submissionToken/setup-config", requireSubmissionToken, async (req, res) => {
    try {
        const calib = await db.getOralCalibration(req.work.id);
        res.set("Cache-Control", "no-store");
        res.json({
            proctoring_enabled: req.work.proctoring_enabled === true,
            calibration: { enabled: !!calib, sentence: calib?.sentence || null, max_attempts: MAX_CALIB_ATTEMPTS },
        });
    } catch (err) {
        log.error("SUBMISSION", `setup-config failed: ${err.message}`);
        res.status(500).json({ error: "falha ao carregar o setup" });
    }
});

// Calibração de fala da ENTREVISTA: recebe a repetição gravada, transcreve com o
// MESMO gpt-4o-transcribe da correção e pontua contra a frase-alvo. NUNCA bloqueia
// (após MAX_CALIB_ATTEMPTS o aluno segue). Reaproveita lib/speechCalib.js e as
// colunas submissions.oral_calibration_json. Espelha /oral/calibrate (prova oral).
router.post("/s/:submissionToken/calibrate", requireSubmissionToken, audioUpload.single("file"), async (req, res) => {
    try {
        const calib = await db.getOralCalibration(req.work.id);
        if (!calib) return res.status(409).json({ error: "sem frase de calibração" });
        if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: "envie um arquivo" });
        let attempt = Number(req.body?.attempt);
        if (!Number.isInteger(attempt) || attempt < 1) attempt = 1;
        if (attempt > MAX_CALIB_ATTEMPTS) attempt = MAX_CALIB_ATTEMPTS;

        const { text } = await transcribeAudio(clientForWork(req.work), STT_MODEL, req.file.buffer, `calib.${extFromMimetype(req.file.mimetype)}`);
        const { ok, wer, missedTerms } = scoreCalibration({ target: calib.sentence, keyTerms: calib.key_terms || [], hypothesis: text });

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

        log.info("SUBMISSION", `calibrate submission=${req.submission.submission_token} attempt=${attempt} ok=${ok} wer=${wer == null ? "—" : wer.toFixed(2)}`);
        res.json({
            ok, attempt, attempts_left: Math.max(0, MAX_CALIB_ATTEMPTS - attempt),
            wer, missed_terms: missedTerms, transcript: text, advice: ok ? null : CALIB_ADVICE,
        });
    } catch (err) {
        log.error("SUBMISSION", `calibrate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao verificar a captação", detail: err.message });
    }
});

// Vídeo do proctoring da ENTREVISTA: gravação contínua (cam+mic) enviada no fim.
// Armazena via putAudio (reusa o adaptador de storage) e acumula a chave em
// submissions.oral_video_key (mesma coluna/parts da prova oral). O proctoring em
// lote (Fase 4) analisa esse vídeo. Best-effort: falha aqui não quebra a entrevista.
router.post("/s/:submissionToken/proctor-video", requireSubmissionToken, videoUpload.single("file"), async (req, res) => {
    try {
        if (req.work.proctoring_enabled !== true) return res.status(400).json({ error: "proctoring desligado" });
        if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: "envie um arquivo" });
        const ext = extFromMimetype(req.file.mimetype) || "webm";
        const key = `proctor-video/${req.submission.submission_token}-${Date.now()}.${ext}`;
        const r = await putAudio({ key, buffer: req.file.buffer, mimetype: req.file.mimetype });
        if (!r.stored) {
            log.error("SUBMISSION", `proctor-video não armazenado submission=${req.submission.submission_token}: ${r.reason}`);
            return res.status(502).json({ error: "falha ao armazenar o vídeo", detail: r.reason });
        }
        await db.appendOralVideoPart(req.submission.id, key);
        // Gate de vídeo obrigatório: se a submissão estava aguardando o vídeo p/
        // concluir (encerrou antes de o vídeo subir), promove para concluída.
        const promoted = await db.promoteAwaitingVideo(req.submission.id);
        log.info("SUBMISSION", `proctor-video armazenado submission=${req.submission.submission_token} key=${key} bytes=${req.file.buffer.length}${promoted ? " (conclui: aguardava vídeo)" : ""}`);
        // Análise de vídeo AUTOMÁTICA (#210): dispara em background ao chegar o vídeo
        // (não espera o professor rodar "Avaliar entrevistas"). O lote segue como
        // backstop idempotente.
        runProctorAuto(req.submission.id, req.submission.submission_token);
        res.json({ ok: true });
    } catch (err) {
        log.error("SUBMISSION", `proctor-video failed: ${err.message}`);
        res.status(500).json({ error: "falha no upload do vídeo", detail: err.message });
    }
});

// Áudios FIXOS de instrução do setup de proctoring (posicionamento / comandos),
// sintetizados por TTS na voz do trabalho e cacheados em memória (texto fixo).
const SETUP_SCRIPTS = {
    position: "Vamos ajustar a sua posição para a prova. Fique de frente para a câmera, a cerca de um metro e meio de distância, de forma que apareçam a sua cabeça e o seu tronco. Deixe as duas mãos à mostra. Você precisa estar sozinho, sem outras pessoas no quadro, e não pode usar o celular durante a prova. Se algo estiver fora do lugar, a tela vai avisar com uma borda vermelha e uma mensagem embaixo. Ajuste a sua posição até ficar tudo certo.",
    commands: "Agora vamos praticar os comandos. Na entrevista, você responde gravando mensagens de áudio e, como fica longe do teclado, comanda tudo com a mão, nas áreas dos cantos da tela. Em cima à direita, Gravar. Em cima à esquerda, Cancelar. Embaixo à direita, Enviar. Ponha a mão sobre uma área e segure enquanto ela conta até três. Apenas os comandos que podem ser usados ficam ativos.",
};
const setupAudioCache = new Map(); // `${which}|${voice}` -> Buffer
router.get("/s/:submissionToken/setup-audio", requireSubmissionToken, async (req, res) => {
    try {
        const which = String(req.query.which || "");
        const text = SETUP_SCRIPTS[which];
        if (!text) return res.status(400).json({ error: "which inválido" });
        const voice = req.work.voice || "coral";
        const key = `${which}|${voice}`;
        let buf = setupAudioCache.get(key);
        if (!buf) { buf = await synthesizeSpeech(clientForWork(req.work), TTS_MODEL, text, voice); setupAudioCache.set(key, buf); }
        res.type("audio/mpeg").send(buf);
    } catch (err) {
        log.error("SUBMISSION", `setup-audio failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar o áudio de instrução" });
    }
});

// ============================================================================
// POST /s/:submissionToken/upload
// ============================================================================
router.post("/s/:submissionToken/upload", requireSubmissionToken, requireNotFinalized, requireWithinBudget, studentUpload.single("file"), async (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(400).json({ error: "sessão não iniciada — recarregue a página" });
    if (!req.file) return res.status(400).json({ error: "envie um arquivo" });
    if (exceedsPageLimit(req.file.buffer)) {
        return res.status(400).json({ error: `o PDF tem mais de ${MAX_PDF_PAGES} páginas — envie um arquivo menor (limite ${MAX_PDF_PAGES})` });
    }

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

    // Gate B (pacotes): a cota já foi RESERVADA quando o professor gerou este
    // token (ver routes/work.js#POST submissions + lib/packages.js#reserveSeats).
    // A execução não saca de novo — o assento é deste token. Só o orçamento US$
    // (requireWithinBudget, acima) é checado por tentativa.

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
    // Fiscalização por vídeo já garante integridade → não pedir "resposta de cabeça"
    // (o beat de espontaneidade do intro lê sess.expectSpontaneous).
    sess.expectSpontaneous = req.work.expect_spontaneous === true && req.work.proctoring_enabled !== true;
    // Persona segue, em ordem de prioridade: (1) override do professor, (2)
    // gênero da voz em modo áudio, (3) sorteio balanceado em modo texto.
    // A pré-geração no /start já escolheu uma persona; só re-picka se a config
    // divergiu entre /start e /upload (raro). Re-pick invalida o cache da
    // saudação pré-gerada — caminho lento (gera fresh).
    const identityOverride = req.work.interviewer_name && req.work.interviewer_gender
        ? { name: req.work.interviewer_name, gender: req.work.interviewer_gender }
        : null;
    const newVoiceGender = voiceGenderOf(sess.voice);
    const personaNeedsRepick = identityOverride
        ? (sess.interviewerPersona?.name !== identityOverride.name
           || sess.interviewerPersona?.gender !== identityOverride.gender)
        : ((newVoiceGender === "f" || newVoiceGender === "m")
           && sess.interviewerPersona?.gender !== newVoiceGender);
    if (personaNeedsRepick || !sess.interviewerPersona) {
        sess.interviewerPersona = pickPersona({
            voiceGender: newVoiceGender,
            overrides: identityOverride,
            seed: req.work.work_token,
        });
        sess.preGeneratedGreeting = null;
    }
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

        // Prep pesada (PDF do aluno + vector store + work_analysis + plano)
        // segue rodando em background a partir daqui — não bloqueia a resposta
        // do /upload. Inputs ficam guardados na sessão para permitir retry caso
        // a primeira execução em background falhe.
        sess.preparationInputs = {
            submissionId: req.submission.id,
            studentBuffer,
            studentFilename,
            enunciadoBlob,
            questionCount: req.work.question_count,
            meterCtx,
            token,
        };
        startInterviewPreparation(sess);

        // Saudação e áudio do orientador foram pré-gerados no /start (ver
        // maybeKickOffPregeneration em sessionLifecycle.js). Aguarda as
        // promessas se ainda em vôo; usa o resultado se o snapshot bater com
        // o estado atual, senão cai pro caminho lento (gera fresh, equivalente
        // ao comportamento antigo).
        sess.introStep = "awaiting_name";

        if (sess.greetingPreGenPromise) {
            try { await sess.greetingPreGenPromise; }
            catch (err) { log.error("PREGEN", `await greeting failed: ${err.message}`); }
        }
        const curSnap = pregenSnapshot(sess);
        let greeting;
        let audio;
        const pre = sess.preGeneratedGreeting;
        const preMatches = pre
            && pre.snapshot
            && pre.snapshot.personaName === curSnap.personaName
            && pre.snapshot.personaGender === curSnap.personaGender
            && pre.snapshot.voice === curSnap.voice
            && pre.snapshot.mode === curSnap.mode;
        if (preMatches) {
            greeting = { message: pre.text, reason: pre.reason };
            audio = pre.audio ?? {};
            log.info("UPLOAD", `using pre-generated greeting (snapshot match)`);
        } else {
            log.info("UPLOAD", `pre-gen miss (mode/voice/persona divergiram ou pre-gen falhou) — fallback fresh`);
            greeting = await introductionAgent.evaluate({
                step: "ask_name",
                interviewerYamlText,
                persona: sess.interviewerPersona,
                introHistory: sess.introLog,
                studentMessage: null,
                meterCtx,
                interactionMode: sess.interactionMode,
            });
            audio = await attachAudio(sess, greeting.message);
        }

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
            await sess.openai.conversations.items.create(sess.conversationId_chat, {
                items: [{ role: "assistant", content: greeting.message }],
            });
        } catch (err) {
            log.error("CHAT", `remote write (intro greeting) failed: ${err.message}`);
        }

        log.info("CHAT", `intro greeting persona=${sess.interviewerPersona.name}/${sess.interviewerPersona.city} ${log.preview(greeting.message, 120)}`);
        await logLastConvItem(sess.conversationId_chat, "CONV:chat", sess.openai);

        await persistConversationLog(sess);

        // Áudio do orientador (pré-gerado no /start em modo áudio). Aguarda a
        // promessa em vôo se necessário; cai pra geração lenta como fallback.
        let narratorPayload = null;
        if (sess.interactionMode === "audio") {
            if (sess.narratorPreGenPromise) {
                try { await sess.narratorPreGenPromise; }
                catch (err) { log.error("PREGEN", `await narrator failed: ${err.message}`); }
            }
            if (sess.narratorAudio?.buffer) {
                narratorPayload = {
                    audio_url: sess.narratorAudio.url,
                    audio_duration_seconds: sess.narratorAudio.durationSec,
                    voice_id: sess.narratorAudio.voiceId,
                };
            } else {
                // Último recurso — gera agora síncrono. Não deveria acontecer
                // a menos que a pré-geração tenha falhado e ninguém retry.
                const r = await attachNarratorAudio(sess, meterCtx);
                if (r && !r.audio_error) narratorPayload = r;
            }
        }

        res.json({
            ok: true,
            assistant: greeting.message,
            ...audio,
            narrator: narratorPayload,
        });
    } catch (error) {
        log.error("UPLOAD", `failed: ${error.message}`);
        res.status(500).json({ error: "Erro ao processar arquivo com a IA" });
    }
});

// ============================================================================
// GET /s/:submissionToken/narrator-audio
// Serve o buffer do áudio do orientador. Vive em sess.narratorAudio.buffer
// (separado do audioCache LRU dos turnos para não ser evictado).
// ============================================================================
router.get("/s/:submissionToken/narrator-audio", requireSubmissionToken, requireNotFinalized, (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess || !sess.narratorAudio?.buffer) return res.status(404).json({ error: "sem áudio de narração" });
    res.type("audio/mpeg");
    res.send(sess.narratorAudio.buffer);
});

// ============================================================================
// GET /s/:submissionToken/audio/:turnId
// Serve o áudio do entrevistador a partir do cache em memória.
// 404 se o turno foi evictado (cache LRU).
// NÃO usa requireNotFinalized: é uma leitura de áudio já gerado. O finalize seta
// completion_reason ANTES de a resposta voltar, então o áudio da DESPEDIDA (que
// vem no mesmo /chat que finaliza) seria barrado com 410 e o aluno veria um
// player quebrado — nunca ouvindo o adeus. A sessão e o cache sobrevivem ao
// finalize, então servir aqui é seguro (read-only).
// ============================================================================
router.get("/s/:submissionToken/audio/:turnId", requireSubmissionToken, (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(404).json({ error: "sessão não encontrada" });
    const buffer = sess.audioCache?.get(String(req.params.turnId));
    if (!buffer) return res.status(404).json({ error: "audio expired or not found" });
    res.type("audio/mpeg");
    res.send(buffer);
});

// Telemetria de latência por turno (modo áudio). Converte os marcos absolutos
// (Date.now) em deltas em ms e acumula em sess.serverTimings, persistido no
// conversation_json (server_timings) para análise do tempo percebido pelo aluno.
// Marcos: recv (entrada) → stt (transcrição pronta) → firstToken (1º token do
// orquestrador, pós chain-of-thought) → ttsStart/ttsDone (síntese+download do
// áudio) → done (resposta enviada). tts_ms é o alvo da fragmentação.
function recordTurnTimings(sess, m, kind) {
    if (!sess.serverTimings) sess.serverTimings = [];
    const d = (a, b) => (a != null && b != null ? b - a : null);
    sess.serverTimings.push({
        kind: kind ?? null,
        at: new Date().toISOString(),
        stt_ms: d(m.recv, m.stt),
        think_to_first_token_ms: d(m.stt, m.firstToken),
        first_token_to_tts_ms: d(m.firstToken, m.ttsStart),
        tts_first_ms: d(m.ttsStart, m.ttsFirst),
        tts_ms: d(m.ttsStart, m.ttsDone),
        tts_to_done_ms: d(m.ttsDone, m.done),
        total_ms: d(m.recv, m.done),
    });
}

// ============================================================================
// POST /s/:submissionToken/suggest-answer
// Sugere uma resposta de aluno (LLM) para o PROFESSOR em conversas de TESTE.
// Gated server-side por sess.isTest (esconder o botão na UI não basta). NÃO onera
// o orçamento (meterCtx null). Body: { profile, want_audio }. Resposta:
// { text, audio_base64? }. Reusa lib/studentSimulator (mesmo gerador do harness).
// ============================================================================
router.post("/s/:submissionToken/suggest-answer", requireSubmissionToken, requireNotFinalized, async (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(400).json({ error: "sessão não iniciada — recarregue a página" });
    if (!sess.isTest) {
        return res.status(403).json({ error: "not_a_test", message: "Sugestão de resposta disponível apenas em conversas de teste." });
    }
    const profileKey = String(req.body?.profile || "domina");
    const profile = STUDENT_PROFILES[profileKey] || STUDENT_PROFILES.domina;
    const wantAudio = req.body?.want_audio === true;
    const providedText = typeof req.body?.text === "string" ? req.body.text.trim() : "";

    // Caminho B — síntese de voz de um texto JÁ gerado e (possivelmente) editado
    // pelo professor. Separa "gerar resposta" (texto) de "enviar por voz" (TTS do
    // texto vigente): o professor sempre vê/edita o texto antes. meterCtx null
    // (não onera o orçamento). A voz do aluno é diferente da do entrevistador.
    if (providedText && wantAudio) {
        if (sess.interactionMode !== "audio") {
            return res.status(400).json({ error: "not_audio", message: "Síntese de voz só em entrevista de áudio." });
        }
        const studentVoice = sess.voice === "verse" ? "alloy" : "verse";
        try {
            const buffer = await synthesizeSpeech(openai, TTS_MODEL, providedText, studentVoice);
            log.info("SUGGEST", `tts-only chars=${providedText.length}`);
            return res.json({ audio_base64: buffer.toString("base64") });
        } catch (err) {
            log.error("SUGGEST", `TTS falhou: ${err.message}`);
            return res.status(500).json({ error: "tts_failed", message: "Não consegui sintetizar a voz agora." });
        }
    }

    // Caminho A — gera a resposta em TEXTO. A última fala do entrevistador é a
    // pergunta a responder; o resto é histórico.
    const chat = Array.isArray(sess.conv_chat) ? sess.conv_chat : [];
    let qIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].role === "assistant") { qIdx = i; break; }
    }
    if (qIdx < 0) {
        return res.status(409).json({ error: "no_question", message: "Ainda não há pergunta do entrevistador para responder." });
    }
    const question = chat[qIdx].content;
    const history = chat.slice(0, qIdx).map(m => ({
        role: m.role === "assistant" ? "interviewer" : "aluno",
        text: m.content,
    }));

    try {
        const text = await generateStudentAnswer({
            systemBehavior: profile.system,
            history,
            question,
            // Ancora na análise prévia do trabalho (resumo estruturado já na sessão).
            workContext: sess.workAnalysis ? JSON.stringify(sess.workAnalysis) : null,
            meterCtx: null, // sugestão de teste: NÃO debita o orçamento do trabalho.
        });
        const payload = { text, profile: profileKey };
        if (wantAudio && sess.interactionMode === "audio") {
            // Voz de aluno diferente da do entrevistador, para não confundir.
            const studentVoice = sess.voice === "verse" ? "alloy" : "verse";
            try {
                const buffer = await synthesizeSpeech(openai, TTS_MODEL, text, studentVoice);
                payload.audio_base64 = buffer.toString("base64");
            } catch (err) {
                log.error("SUGGEST", `TTS falhou: ${err.message}`);
                payload.audio_error = true;
            }
        }
        log.info("SUGGEST", `profile=${profileKey} audio=${!!payload.audio_base64} ${log.preview(text, 80)}`);
        return res.json(payload);
    } catch (err) {
        log.error("SUGGEST", `geração falhou: ${err.message}`);
        return res.status(500).json({ error: "generation_failed", message: "Não consegui gerar uma sugestão agora." });
    }
});

// ============================================================================
// POST /s/:submissionToken/chat
// ============================================================================
router.post("/s/:submissionToken/chat", requireSubmissionToken, requireNotFinalized, requireWithinBudget, audioUpload.single("audio"), async (req, res) => {
    const token = req.submission.submission_token;
    const sess = SESSIONS.get(token);
    if (!sess) return res.status(400).json({ error: "sessão não iniciada — recarregue a página" });
    // O aluno respondeu — para os pings de keep-alive do gap anterior.
    cancelKeepalive(sess);
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

    // Idempotência do turno: o frontend envia um client_msg_id por AÇÃO de envio
    // (retries de transporte reusam o id). Repetição de turno concluído → replay
    // do resultado em cache, sem reprocessar (era o bug do turno duplicado);
    // repetição com o original ainda em curso → 409. Antes do STT: repetição não
    // paga transcrição. Sem id (cliente antigo) → comportamento de sempre.
    const clientMsgId = (req.body?.client_msg_id || "").toString().slice(0, 80) || null;
    {
        const dd = decideChatDedup(sess.chatDedup ?? null, clientMsgId, Date.now());
        if (dd.decision === "replay") {
            log.warn("CHAT", `client_msg_id repetido (${clientMsgId}) — replay do resultado em cache, turno NÃO reprocessado`);
            if (isAudioMode) {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache, no-transform",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                });
                res.write(`event: result\ndata: ${JSON.stringify(dd.next.result)}\n\n`);
                return res.end();
            }
            return res.json(dd.next.result);
        }
        if (dd.decision === "reject_in_flight") {
            log.warn("CHAT", `client_msg_id ${clientMsgId} ainda em processamento — 409`);
            return res.status(409).json({ error: "duplicate_in_flight", detail: "Esta mensagem já está sendo processada. Aguarde a resposta." });
        }
        sess.chatDedup = dd.next;
    }
    // Sucesso passa por aqui (sendFinal e saídas da intro); erro respondido ao
    // cliente passa por dedupAbort para liberar reenvio imediato do mesmo id.
    const dedupDone = (payload) => {
        sess.chatDedup = markChatDone(sess.chatDedup ?? null, clientMsgId, payload, Date.now());
        return payload;
    };
    const dedupAbort = () => { sess.chatDedup = abortChatDedup(sess.chatDedup ?? null, clientMsgId); };

    // Telemetria de latência (modo áudio): marcos absolutos por turno. Viram
    // deltas e são persistidos em server_timings via recordTurnTimings/sendFinal.
    const tMarks = { recv: Date.now(), stt: null, firstToken: null, ttsStart: null, ttsFirst: null, ttsDone: null, done: null };
    let timingKind = null;
    let message;
    // Duração da mensagem de voz do aluno (segundos). Em modo texto fica null.
    // Probada do buffer original antes do STT — não depende do shape do response.
    let studentAudioDurationSec = null;
    // Logprobs por token do STT, consumidos pelo pré-gate de inteligibilidade.
    // Em modo texto fica null e o gate é no-op.
    let studentAudioLogprobs = null;
    let studentAudioBuffer = null;
    let studentAudioMimetype = null;
    if (hasAudio) {
        try {
            studentAudioDurationSec = await getAudioDurationSeconds(
                req.file.buffer,
                req.file.mimetype || null,
            );
            const sttResult = await meteredStt(
                { ...sessionMeterCtx(sess), model: STT_MODEL },
                () => transcribeAudio(sess.openai || openai, STT_MODEL, req.file.buffer, req.file.originalname || "audio.webm")
            );
            message = sttResult.text;
            studentAudioLogprobs = sttResult.logprobs ?? null;
            // Preserva o buffer pra arquivamento best-effort APÓS o STT ter
            // sucesso. Só guarda se a fala for usada (passou pelo pré-gate
            // de inteligibilidade — checado mais abaixo).
            studentAudioBuffer = req.file.buffer;
            studentAudioMimetype = req.file.mimetype || null;
        } catch (err) {
            log.error("CHAT", `STT failed: ${err.message}`);
            dedupAbort();
            return res.status(400).json({ error: "transcription_failed", detail: "Não consegui entender o áudio. Tente gravar de novo." });
        }
    } else {
        message = (req.body?.message || "").toString();
    }
    tMarks.stt = Date.now();
    if (!message) { dedupAbort(); return res.status(400).json({ error: "empty message" }); }
    // Instrumentação de espontaneidade (Fase 2): tempos do cliente (modo áudio).
    // time_to_start = da pergunta pronta ao apertar gravar; record_duration = fala.
    // Gravados no turno (conversation_json) para a avaliação da espontaneidade.
    const clientTimeToStartMs = numOrNull(req.body?.client_time_to_start_ms);
    const clientRecordDurationMs = numOrNull(req.body?.client_record_duration_ms);
    const clientTiming = (clientTimeToStartMs != null || clientRecordDurationMs != null)
        ? { time_to_start_ms: clientTimeToStartMs, record_duration_ms: clientRecordDurationMs }
        : null;
    // Arquivamento da gravação do aluno (best-effort, audio mode apenas).
    // Acontece ANTES do pré-gate — áudios ininteligíveis também são
    // arquivados como evidência pra eventual auditoria. Falha silenciosa.
    if (studentAudioBuffer) {
        // turn_index: a fala pertence ao último turno aberto na fase
        // interviewing (resposta ou intervenção dele). Na intro não há turno.
        const archiveTurnIndex = sess.currentPhase === "interviewing" && Array.isArray(sess.turnLog) && sess.turnLog.length > 0
            ? sess.turnLog[sess.turnLog.length - 1].index
            : null;
        archiveStudentAudio({
            submissionId: req.submission.id,
            submissionToken: token,
            buffer: studentAudioBuffer,
            mimetype: studentAudioMimetype,
            durationS: studentAudioDurationSec,
            turnIndex: archiveTurnIndex,
        }).catch(err => log.error("AUDIO_STORE", `archive promise rejeitada: ${err.message}`));
    }
    // Cap de tamanho (defesa contra injection por mensagem longa). Áudio raramente
    // estoura — STT de minutos de fala fica bem abaixo de 4000 chars. Texto pode
    // estourar com colagem. Erro explícito pro frontend tratar.
    if (message.length > MAX_STUDENT_MESSAGE_CHARS) {
        log.warn("CHAT", `mensagem excede cap (${message.length} > ${MAX_STUDENT_MESSAGE_CHARS}) submission=${token}`);
        return res.status(413).json({
            error: "message_too_long",
            detail: `A mensagem excedeu o limite de ${MAX_STUDENT_MESSAGE_CHARS} caracteres. Encurte e tente de novo.`,
            limit: MAX_STUDENT_MESSAGE_CHARS,
            length: message.length,
        });
    }

    const persist = () => persistConversationLog(sess);

    // ------------------------------------------------------------------
    // Classificação de inteligibilidade (modo áudio). Roda ANTES do bloco intro
    // ou triagem. Três desfechos — NUNCA se descarta a fala (o áudio já foi
    // arquivado acima):
    //   "seguir"  → segue normal.
    //   "avisar"  → segue normal, mas anexa uma Dica não-bloqueante à resposta.
    //   "repetir" → pede repetição + Dica, e RETÉM a transcrição no contexto do
    //               orquestrador (marcada baixa-confiança) para o aluno não
    //               repetir tudo. O turno não avança (return aqui).
    // ------------------------------------------------------------------
    // Dois votantes independentes, combinados por SEVERIDADE-MÁXIMA:
    //   (1) logprob (server-side, à prova de adulteração) — garble "barulhento"
    //       de respostas longas, onde o STT fica incerto.
    //   (2) acústico (calculado no navegador, reportado no upload) — barulho de
    //       fundo / SNR baixo, que pega o "confidently-wrong" de música alta
    //       (o STT erra COM confiança → invisível ao logprob por construção).
    // Cada votante mapeia para seguir/avisar/repetir; vence o pior. Um votante
    // sem sinal vota "seguir" (mudo). spans/aggregate do logprob alimentam o
    // destaque na Dica; um desfecho dirigido pelo acústico não tem spans.
    let dicaPayload = null;
    if (hasAudio) {
        const votes = [];
        let spans = [];
        let aggregate = null;
        if (AUDIO_INTELLIGIBILITY.enabled && studentAudioLogprobs) {
            const cls = classifyAudio(studentAudioLogprobs, AUDIO_INTELLIGIBILITY);
            spans = cls.spans;
            aggregate = cls.aggregate;
            votes.push({ tier: cls.outcome, source: "logprob" });
            const m = cls.metrics || {};
            log.info("AUDIO:Gate", `logprob=${cls.outcome} tokens=${cls.aggregate?.totalTokens ?? 0}` +
                ` pctWarn=${m.pctWarn != null ? (m.pctWarn * 100).toFixed(0) + "%" : "—"} runRepeat=${m.maxRunRepeat ?? 0} spans=${cls.spans.length}`);
        }
        if (ACOUSTIC.enabled) {
            const snr = numOrNull(req.body?.acoustic_snr);
            const bak = numOrNull(req.body?.acoustic_bak);
            const ac = classifyAcoustic({ snr, bak }, ACOUSTIC);
            if (ac.sources.length) votes.push({ tier: ac.tier, source: ac.sources.join("+") });
            log.info("AUDIO:Acoustic", `snr=${snr ?? "—"}dB(${ac.tiers.snr ?? "off"}) bak=${bak ?? "—"}(${ac.tiers.bak ?? "off"}) -> ${ac.tier}`);
        }
        const combined = combineTiers(votes);
        const acousticDriven = combined.sources.length > 0 && !combined.sources.includes("logprob");
        const reason = acousticDriven ? "acoustic" : "logprob";
        if (combined.tier !== "seguir") {
            log.info("AUDIO:Gate", `combined=${combined.tier} sources=${combined.sources.join(",")} reason=${reason}`);
        }
        if (combined.tier === "repetir") {
            const result = await runAudioRepeat({ sess, transcript: message, spans, aggregate, persist, reason });
            return res.json(dedupDone(result.response));
        } else if (combined.tier === "avisar") {
            dicaPayload = buildAvisarDica(message, spans, reason);
        }
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
            await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
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
                    expectSpontaneous: !!sess.expectSpontaneous,
                });
            } catch (err) {
                log.error("AGENT:Introduction", `present_self failed, using fallback: ${err.message}`);
                intro = { message: "Prazer em falar contigo. Quando você estiver pronto, me dá um ok que a gente começa.", student_name: null, reason: "agent_failed" };
            }

            if (intro.student_name) sess.studentName = intro.student_name;
            if (intro.student_gender_preference) sess.studentGenderHint = intro.student_gender_preference;
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
                await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: intro.message }] });
            } catch (err) {
                log.error("CHAT", `remote write (intro present_self) failed: ${err.message}`);
            }
            log.info("CHAT", `intro present_self${sess.studentName ? ` name="${sess.studentName}"` : ""} ${log.preview(intro.message, 120)}`);
            await logLastConvItem(sess.conversationId_chat, "CONV:chat", sess.openai);
            persist();
            return res.json(dedupDone({ channel: "chat", assistant: intro.message, ...audio, ...(dicaPayload ? { audio_intelligibility: { hint: dicaPayload } } : {}) }));
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
                studentGenderHint: sess.studentGenderHint ?? null,
                meterCtx: sessionMeterCtx(sess),
                interactionMode: sess.interactionMode,
            });
        } catch (err) {
            log.error("AGENT:Introduction", `begin failed, using fallback: ${err.message}`);
            begin = { message: "Então vamos começar.", reason: "agent_failed" };
        }

        const firstPlanQuestion = sess.interviewPlan.questions[0];
        const combined = `${begin.message}\n\n${firstPlanQuestion.question}`;

        // A 1ª pergunta (este beat) também é fragmentada no modo áudio: a abertura
        // deixa de ser um blob único — que demorava a tocar e "liberava tudo de uma
        // vez" — e passa a tocar pedaço a pedaço, como o resto da entrevista. Reusa
        // a mesma máquina de SSE + audio_chunk da fase interviewing; o frontend já
        // ramifica por content-type (sendAudioBlob), então nada muda lá. Em texto,
        // segue blob/JSON.
        const beginUseSSE = isAudioMode;
        let beginHeartbeat = null;
        const clearBeginHeartbeat = () => { if (beginHeartbeat) { clearInterval(beginHeartbeat); beginHeartbeat = null; } };
        if (beginUseSSE) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.write(`event: thinking\ndata: {}\n\n`);
            res.write(`event: responding\ndata: {}\n\n`);
            beginHeartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch { clearBeginHeartbeat(); } }, 10000);
            res.on("close", clearBeginHeartbeat);
        }

        try {
            const audio = beginUseSSE
                ? await attachAudioChunks(sess, combined, (chunk) => { res.write(`event: audio_chunk\ndata: ${JSON.stringify(chunk)}\n\n`); })
                : await attachAudio(sess, combined);
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
                await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: combined }] });
            } catch (err) {
                log.error("CHAT", `remote write (intro begin) failed: ${err.message}`);
            }
            log.info("CHAT", `intro begin + first plan question ${log.preview(combined, 160)}`);
            await logLastConvItem(sess.conversationId_chat, "CONV:chat", sess.openai);
            persist();

            const payload = dedupDone({ channel: "chat", assistant: combined, phase: "interviewing", ...audio, ...(dicaPayload ? { audio_intelligibility: { hint: dicaPayload } } : {}) });
            if (beginUseSSE) {
                clearBeginHeartbeat();
                res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
                return res.end();
            }
            return res.json(payload);
        } catch (err) {
            log.error("INTRO", `begin tail failed: ${err.message}`);
            if (beginUseSSE) {
                clearBeginHeartbeat();
                try { res.write(`event: error\ndata: ${JSON.stringify({ error: "Falha ao gerar a abertura. Tente novamente.", message: "Falha ao gerar a abertura. Tente novamente.", status: 500 })}\n\n`); } catch {}
                try { res.end(); } catch {}
                return;
            }
            return res.status(500).json({ error: "Falha ao gerar a abertura. Tente novamente." });
        }
    }

    // ------------------------------------------------------------------
    // SUPER-ORQUESTRADOR (experimento). UMA chamada de raciocínio decide a
    // próxima ação: ask | follow_up | meta_modal | hint | finalize | ask_repeat.
    // Substitui triagem×3 + sufficiency + relevance + composição do legado.
    // Guardrails de turnos no código (não confia 100% no agente). Ver
    // docs/super-orchestrator-plan.md.
    //
    // SSE (Server-Sent Events) no caminho ÁUDIO: o frontend troca o label do
    // balão de "ouvindo" para "respondendo" no momento real em que o modelo
    // começa a emitir tokens de texto (após o chain-of-thought interno). Em
    // texto, mantém JSON único — não há balão para sinalizar.
    // ------------------------------------------------------------------
    const currentTurn = sess.turnLog?.[sess.turnLog.length - 1] ?? null;
    const turnsAnswered = sess.turnLog.filter(t => t && t.answered_at).length;

    const useSSE = isAudioMode;
    // Heartbeat keep-alive do SSE (C1). O gap entre 'thinking' (t=0) e o 1º token
    // do super-orquestrador — e depois entre 'responding' e o TTS — pode passar de
    // 30-50s SEM trafegar byte. O idle timeout do proxy do Autoscale corta a conexão
    // nesse silêncio: o servidor conclui o turno, mas o cliente não recebe nada. Um
    // comentário SSE ': ping' a cada 10s mantém bytes fluindo. Linhas de comentário
    // (começam com ':') são ignoradas pelo EventSource e pelo consumeSSE do front
    // (não casam com 'event:'/'data:'), então não afetam o protocolo.
    let heartbeat = null;
    const clearHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
    if (useSSE) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            // Hint para nginx-like proxies não bufferizarem nosso stream.
            "X-Accel-Buffering": "no",
        });
        // Sinal inicial — frontend pode usar pra confirmar que abriu o stream.
        res.write(`event: thinking\ndata: {}\n\n`);
        heartbeat = setInterval(() => {
            try { res.write(`: ping\n\n`); } catch { clearHeartbeat(); }
        }, 10000);
        // Cliente desconectou no meio → não deixa o interval vazando.
        res.on("close", clearHeartbeat);
    }
    // Despacha o payload final. Em SSE, vira event: result + end. Em JSON,
    // res.json clássico. Toda saída bem-sucedida desta rota passa aqui.
    const sendFinal = (payload) => {
        // Telemetria: carimba o fim e registra os deltas do turno (modo áudio)
        // para análise da latência percebida. Ver server_timings no log.
        tMarks.done = Date.now();
        if (isAudioMode) recordTurnTimings(sess, tMarks, timingKind);
        // Caso "avisar": anexa a Dica não-bloqueante à resposta normal (a menos
        // que o próprio fluxo já tenha uma, ex.: hint de áudio).
        if (dicaPayload && !payload.audio_intelligibility) {
            payload = { ...payload, audio_intelligibility: { hint: dicaPayload } };
        }
        payload = dedupDone(payload);
        if (useSSE) {
            clearHeartbeat();
            res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
            res.end();
        } else {
            res.json(payload);
        }
    };
    // Em SSE não dá pra usar res.status() depois do writeHead, então erros
    // viram event:error com o status no payload.
    const sendError = (status, payload) => {
        dedupAbort();
        if (useSSE) {
            clearHeartbeat();
            res.write(`event: error\ndata: ${JSON.stringify({ ...payload, status })}\n\n`);
            res.end();
        } else {
            res.status(status).json(payload);
        }
    };

    // Guardrail 1: cap duro de turnos. Se já estourou, força finalize sem
    // chamar o agente (economia + segurança).
    const maxTurns = maxTurnsFor(sess);
    if (turnsAnswered >= maxTurns) {
        log.info("SUPER_ORQ", `MAX_TURNS (${maxTurns}) atingido — forçando finalize`);
        const forcedMessage = "Obrigado, acho que já temos material suficiente para encerrar esta conversa.";
        sess.conv_chat.push({ role: "user", content: message });
        sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
        sess.history = sess.conv_chat;
        try {
            await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
        } catch (err) { log.error("CHAT", `remote write (user, cap) failed: ${err.message}`); }
        if (currentTurn && currentTurn.answer == null) {
            currentTurn.answer = message;
            currentTurn.answered_at = new Date().toISOString();
            currentTurn.answer_audio_duration_seconds = studentAudioDurationSec;
            if (clientTiming) currentTurn.client_timing = clientTiming;
        }
        const audio = await attachAudio(sess, forcedMessage);
        sess.conv_chat.push({ role: "assistant", content: forcedMessage });
        sess.conv_eval.push({ role: "assistant", content: forcedMessage, metadata: { kind: "finalize", forced: "max_turns", timestamp: Date.now() } });
        sess.history = sess.conv_chat;
        try {
            await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: forcedMessage }] });
        } catch (err) { log.error("CHAT", `remote write (assistant, cap) failed: ${err.message}`); }
        sess.currentPhase = "finalizing";
        sess.conversationCompleted = true;
        // Despedida durável (B): persiste no conversation_json para sobreviver a
        // queda de conexão e aparecer na revisão do aluno e no log do professor.
        sess.finalization = {
            message: forcedMessage,
            completion_reason: "complete",
            finalize_reason: "max_turns",
            // Lacunas registradas pelo orquestrador ao avançar (guardrail de
            // insistência): persistidas aqui para o InterviewEvaluator vê-las.
            open_threads: Array.isArray(sess.superOrchestratorMemory?.open_threads) ? sess.superOrchestratorMemory.open_threads : [],
            at: new Date().toISOString(),
        };
        await persistFinalization(req, "complete");
        await persist();
        // Estado terminal limpo: invariante runtime_state_json IS NULL ⇔ sem
        // tentativa em andamento. Sem isto a submissão ficava com
        // runtime_state_json não-nulo e current_phase="finalizing" para sempre
        // (in_flight fantasma no painel/analytics).
        try { await db.clearSubmissionRuntimeState(req.submission.id); }
        catch (err) { log.error("SUBMISSION", `clear runtime after max-turns finalize failed: ${err.message}`); }
        return sendFinal({ channel: "chat", assistant: forcedMessage, phase: sess.currentPhase, ...audio });
    }

    // Push da mensagem do aluno ANTES de chamar o agente — o agente lê o
    // histórico via Conversations API (parâmetro `conversation` na
    // responses.create), então a mensagem precisa estar lá no momento da
    // chamada. Para meta_modal a gente pode reverter localmente, mas no
    // remoto fica.
    sess.conv_chat.push({ role: "user", content: message });
    sess.conv_eval.push({ role: "user", content: message, metadata: { timestamp: Date.now() } });
    sess.history = sess.conv_chat;
    try {
        // Espelho remoto SÓ na conv_chat (lida pelo orquestrador via `conversation`).
        // A conv_eval vive apenas no array LOCAL (→ conversation_json p/ o professor):
        // nada lê a conv_eval REMOTA, então paramos de escrevê-la a cada turno.
        await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "user", content: message }] });
    } catch (err) { log.error("CHAT", `remote write (user) failed: ${err.message}`); }
    log.info("CHAT", `user ${log.preview(message, 140)}`);

    // Chama o super-orquestrador. Falha cai pra fallback ask_repeat. Em SSE,
    // passamos onFirstDelta para sinalizar "respondendo" ao frontend no momento
    // real em que o modelo começa a emitir tokens de texto (após o
    // chain-of-thought interno). Em SSE, onMessageReady dispara o TTS cedo
    // (streaming-parse) assim que a fala fecha, em paralelo com rationale/memory.
    let earlyTtsPromise = null;
    let earlyKind = null;
    let earlyMessage = null;
    const onMessageReady = (kind, msg) => {
        if (earlyTtsPromise || kind === "meta_modal") return; // 1x; meta vai p/ modal (blob)
        earlyKind = kind;
        earlyMessage = msg;
        tMarks.ttsStart = Date.now();
        earlyTtsPromise = attachAudioChunks(sess, msg, (chunk) => {
            if (chunk.index === 0 && tMarks.ttsFirst == null) tMarks.ttsFirst = Date.now();
            res.write(`event: audio_chunk\ndata: ${JSON.stringify(chunk)}\n\n`);
        }).then((a) => { tMarks.ttsDone = Date.now(); return a; })
          .catch((e) => { log.error("AUDIO", `early TTS falhou: ${e.message}`); return { audio_error: "tts_failed" }; });
    };
    // ── Teto duro de insistência (guardrail v2 → VINCULANTE) ──────────────
    // O orçamento de follow_up do #109 era conselho (só telemetria). Aqui vira
    // BLOQUEIO: por pergunta, no MÁXIMO 1 follow_up de completude
    // (incomplete/incoherence) e 2 de contradição. Modelos que "não cedem"
    // (família terra) ignoram o conselho; o teto duro os amarra sem depender de
    // obediência ao prompt. Contadores de ENTRADA (o que já foi gasto NESTA
    // pergunta), calculados aqui para (a) suprimir o early-TTS de um follow_up
    // que será vetado e (b) decidir o veto no pós-parse.
    const priorIvsIn = (currentTurn && Array.isArray(currentTurn.interventions)) ? currentTurn.interventions : [];
    const softPriorIn = priorIvsIn.filter(iv => iv?.follow_up_reason === "incomplete" || iv?.follow_up_reason === "incoherence").length;
    const contraPriorIn = priorIvsIn.filter(iv => iv?.follow_up_reason === "contradicts_work" || iv?.follow_up_reason === "contradicts_earlier_self").length;
    // Cota no limite entrando no turno → um follow_up desse tipo será convertido
    // em ask. Desarma o early-TTS para não tocar a fala de um follow_up vetado
    // (custa só a latência do early-TTS, e só nestes turnos de exceção).
    const hardCapArmed = softPriorIn >= 1 || contraPriorIn >= 2;

    let parsed;
    try {
        parsed = await evaluateWithConversationLockRetry(() => superOrchestratorAgent.evaluate({
            interviewerYamlText: sess.interviewerYamlText ?? "",
            workAnalysis: sess.workAnalysis ?? null,
            interviewPlan: sess.interviewPlan ?? null,
            memory: sess.superOrchestratorMemory ?? null,
            turnLog: sess.turnLog,
            studentMessage: message,
            conversationId: sess.conversationId_chat,
            vectorStoreId: sess.vectorStoreId,
            studentName: sess.studentName ?? null,
            studentGenderHint: sess.studentGenderHint ?? null,
            interactionMode: sess.interactionMode,
            meterCtx: sessionMeterCtx(sess),
            // Guardrails reais (derivados do nº de perguntas) também vão no prompt
            // do agente — sem isso ele segue os antigos 5/30 fixos e ignora a
            // configuração do professor.
            minTurnsBeforeFinalize: minTurnsBeforeFinalizeFor(sess),
            maxTurns,
            onFirstDelta: useSSE ? () => {
                if (tMarks.firstToken == null) tMarks.firstToken = Date.now();
                res.write(`event: responding\ndata: {}\n\n`);
            } : null,
            onMessageReady: (useSSE && !hardCapArmed) ? onMessageReady : null,
        }));
    } catch (err) {
        log.error("SUPER_ORQ", `agent failed: ${err.message}`);
        if (earlyMessage && earlyKind) {
            // A fala JÁ foi emitida via streaming-parse antes de o JSON falhar
            // (ex.: truncamento após a message). Reconstrói uma ação coerente com
            // o que a outra ponta já ouviu, em vez do ask_repeat genérico — que
            // contradiria o áudio que já está tocando.
            log.error("SUPER_ORQ", `parse final falhou após emitir a fala; reconstruindo ação kind=${earlyKind}`);
            parsed = {
                rationale: "(reconstruído: o JSON final do super-orquestrador falhou após a fala já ter sido emitida via streaming)",
                action: { kind: earlyKind, message: earlyMessage },
                memory: sess.superOrchestratorMemory ?? null,
            };
        } else {
            parsed = {
                rationale: `Falha do super-orquestrador: ${err.message}. Pedindo repetição como fallback.`,
                action: { kind: "ask_repeat", message: "Desculpa, tive um problema aqui. Pode repetir a sua última resposta?" },
                memory: sess.superOrchestratorMemory ?? null,
            };
        }
    }

    // Keep-alive do cache (opt-in): enquanto o aluno pensa na resposta desta
    // pergunta, pinga o MESMO prefixo (instructions+conversation+tools) para
    // não esfriar (lib/cacheKeepalive.js, v2 "ping camaleão"). O cancel
    // correspondente está na entrada do /chat (o aluno respondeu).
    if (parsed?._keepalive) scheduleKeepalive(sess, parsed._keepalive, sessionMeterCtx(sess));

    // Teto duro (variante a): se o modelo insistiu ALÉM da cota da pergunta,
    // veta o follow_up e RE-CHAMA o orquestrador forçando `ask` — ele escreve a
    // ponte na voz da persona e escolhe a próxima pergunta, registrando a lacuna
    // em open_threads. Só dispara na violação → uma chamada extra pontual, muito
    // menor que o espiral de follow_ups que evita. Antes de persistir memory
    // para que a memory FINAL (com a lacuna registrada) seja a gravada.
    if (parsed?.action?.kind === "follow_up") {
        const r = parsed.action.follow_up_reason ?? null;
        const softExhausted = (r === "incomplete" || r === "incoherence") && softPriorIn >= 1;
        const contraExhausted = (r === "contradicts_work" || r === "contradicts_earlier_self") && contraPriorIn >= 2;
        if (softExhausted || contraExhausted) {
            const cota = softExhausted ? `completude(${softPriorIn}/1)` : `contradição(${contraPriorIn}/2)`;
            log.info("GUARDRAIL", `TETO DURO: follow_up "${r}" vetado — cota ${cota} esgotada; forçando avanço (ask)`);
            const directive = `A cota de follow_up DESTA pergunta está ESGOTADA (${cota}). É PROIBIDO neste retorno: follow_up, hint, ask_repeat e finalize. Você DEVE emitir action.kind="ask": avance para a PRÓXIMA pergunta do plano ainda não coberta (ou uma espontânea, se claramente melhor), com uma ponte curta e natural na voz da persona que reconheça o que ficou em aberto SEM reabrir a cobrança. Registre a lacuna não esclarecida em memory.open_threads antes de avançar. NÃO repita a pergunta que a outra ponta já não respondeu.`;
            try {
                const advanced = await evaluateWithConversationLockRetry(() => superOrchestratorAgent.evaluate({
                    interviewerYamlText: sess.interviewerYamlText ?? "",
                    workAnalysis: sess.workAnalysis ?? null,
                    interviewPlan: sess.interviewPlan ?? null,
                    memory: sess.superOrchestratorMemory ?? null,
                    turnLog: sess.turnLog,
                    studentMessage: message,
                    conversationId: sess.conversationId_chat,
                    vectorStoreId: sess.vectorStoreId,
                    studentName: sess.studentName ?? null,
                    studentGenderHint: sess.studentGenderHint ?? null,
                    interactionMode: sess.interactionMode,
                    meterCtx: sessionMeterCtx(sess),
                    minTurnsBeforeFinalize: minTurnsBeforeFinalizeFor(sess),
                    maxTurns,
                    forceAdvanceDirective: directive,
                }));
                if (advanced?.action?.kind === "ask") {
                    parsed = advanced;
                } else {
                    // Desobediência rara: em vez de re-insistir (o que reabriria o
                    // loop de cobrança que estamos matando), rebaixa localmente
                    // para ask, aproveitando a fala já produzida como ponte.
                    log.error("GUARDRAIL", `re-chamada não retornou ask (kind=${advanced?.action?.kind}); rebaixando p/ ask localmente`);
                    parsed = advanced?.action?.message
                        ? { rationale: advanced.rationale ?? "(teto duro: rebaixado p/ ask)", action: { kind: "ask", plan_question_id: null, message: advanced.action.message }, memory: advanced.memory ?? sess.superOrchestratorMemory ?? null }
                        : { ...parsed, action: { ...parsed.action, kind: "ask", plan_question_id: null } };
                }
            } catch (err) {
                log.error("GUARDRAIL", `re-chamada de avanço falhou: ${err.message}; rebaixando follow_up p/ ask localmente`);
                parsed = { ...parsed, action: { ...parsed.action, kind: "ask", plan_question_id: null } };
            }
        }
    }

    // Persiste memory que o agente devolveu (mesmo no fallback, copia a antiga).
    if (parsed.memory && typeof parsed.memory === "object") {
        sess.superOrchestratorMemory = parsed.memory;
    }

    // Guardrail 2: bloqueio de finalize precoce.
    const minTurnsBeforeFinalize = minTurnsBeforeFinalizeFor(sess);
    if (parsed.action.kind === "finalize"
        && turnsAnswered < minTurnsBeforeFinalize
        && parsed.action.finalize_reason !== "student_disengaged") {
        log.error("SUPER_ORQ", `finalize precoce bloqueado (turnsAnswered=${turnsAnswered} < ${minTurnsBeforeFinalize}, reason=${parsed.action.finalize_reason}); convertendo para ask_repeat`);
        parsed.action = {
            kind: "ask_repeat",
            message: "Vamos seguir um pouco mais — pode me dizer mais sobre a sua última resposta?",
        };
    }

    const kind = parsed.action.kind;
    const assistantMessage = parsed.action.message;
    const rationale = parsed.rationale;
    timingKind = kind;

    // Gera TTS. Se o streaming-parse já disparou a síntese durante o stream
    // (earlyTtsPromise), apenas aguarda — o áudio começou a tocar antes de o JSON
    // fechar (o ganho desta etapa). Senão: caminho áudio normal (fragmentado,
    // exceto meta_modal) ou blob único.
    let audio;
    if (earlyTtsPromise) {
        audio = await earlyTtsPromise;
        // Consistência: a fala tocada deve ser a do JSON final. Divergência indica
        // bug no streaming-parse — loga (o áudio já foi emitido, irreversível).
        if (earlyMessage !== assistantMessage) {
            log.error("SUPER_ORQ", `streaming-parse divergiu: tocado=${log.preview(earlyMessage, 60)} final=${log.preview(assistantMessage, 60)}`);
        }
    } else if (useSSE && kind !== "meta_modal") {
        tMarks.ttsStart = Date.now();
        audio = await attachAudioChunks(sess, assistantMessage, (chunk) => {
            if (chunk.index === 0 && tMarks.ttsFirst == null) tMarks.ttsFirst = Date.now();
            res.write(`event: audio_chunk\ndata: ${JSON.stringify(chunk)}\n\n`);
        });
        tMarks.ttsDone = Date.now();
    } else {
        tMarks.ttsStart = Date.now();
        audio = await attachAudio(sess, assistantMessage);
        tMarks.ttsDone = Date.now();
    }
    const assistantAudioSec = audio.audio_duration_seconds ?? null;

    // ====== Despacha por kind ======

    if (kind === "meta_modal") {
        // Meta: NÃO entra em conv_chat (igual ao legado). Já empurramos a
        // mensagem do aluno em conv_chat acima — precisamos REVERTER esse push
        // local (a mensagem ficou no remoto, mas isso já era o comportamento
        // legado: meta vai pro eval pra audit).
        sess.conv_chat.pop(); // tira a user message recém-empurrada
        sess.conv_eval.push({ role: "assistant", content: assistantMessage, metadata: { kind, rationale, channel: "modal", timestamp: Date.now() } });
        // meta_modal fica só no registro LOCAL (sess.conv_eval → conversation_json);
        // sem espelho remoto (a conv_eval da OpenAI não é lida por ninguém).
        if (currentTurn) {
            if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
            currentTurn.interventions.push({
                type: "meta",
                channel: "modal",
                student_message: message,
                assistant_response: assistantMessage,
                student_audio_duration_seconds: studentAudioDurationSec,
                assistant_audio_duration_seconds: assistantAudioSec,
                rationale,
                at: new Date().toISOString(),
            });
        }
        persist();
        return sendFinal({
            channel: "modal",
            assistant_response: assistantMessage,
            restore_input: message,
            ...audio,
        });
    }

    // Helper: empurra a fala do assistente nos canais visíveis ao aluno.
    const pushAssistantVisible = async (extraEvalMeta = {}) => {
        sess.conv_chat.push({ role: "assistant", content: assistantMessage });
        sess.conv_eval.push({ role: "assistant", content: assistantMessage, metadata: { kind, rationale, ...extraEvalMeta, timestamp: Date.now() } });
        sess.history = sess.conv_chat;
        try {
            await sess.openai.conversations.items.create(sess.conversationId_chat, { items: [{ role: "assistant", content: assistantMessage }] });
        } catch (err) { log.error("CHAT", `remote write (assistant, kind=${kind}) failed: ${err.message}`); }
        await logLastConvItem(sess.conversationId_chat, "CONV:chat", sess.openai);
    };

    if (kind === "follow_up" || kind === "ask_repeat" || kind === "hint") {
        // Telemetria do guardrail de insistência (regra no prompt do
        // SuperOrchestrator): mede violações do orçamento (1 follow_up p/
        // incomplete/incoherence, 2 p/ contradições) SEM bloquear — se a
        // obediência for boa, não precisamos de bloqueio duro no despachante.
        if (kind === "follow_up" && currentTurn) {
            const fupReason = parsed.action.follow_up_reason ?? null;
            const prior = Array.isArray(currentTurn.interventions) ? currentTurn.interventions : [];
            const softPrior = prior.filter(iv => iv?.follow_up_reason === "incomplete" || iv?.follow_up_reason === "incoherence").length;
            const contraPrior = prior.filter(iv => iv?.follow_up_reason === "contradicts_work" || iv?.follow_up_reason === "contradicts_earlier_self").length;
            if ((fupReason === "incomplete" || fupReason === "incoherence") && softPrior >= 1) {
                log.info("GUARDRAIL", `violação do orçamento de insistência (soft): reason=${fupReason} já_usados=${softPrior}/1`);
            } else if ((fupReason === "contradicts_work" || fupReason === "contradicts_earlier_self") && contraPrior >= 2) {
                log.info("GUARDRAIL", `violação do orçamento de insistência (contradição): reason=${fupReason} já_usados=${contraPrior}/2`);
            }
        }
        // Intervenções: NÃO criam novo turno. Empurram fala visível +
        // registram a interação no currentTurn.interventions para auditoria.
        await pushAssistantVisible({ intervention: kind });
        if (currentTurn) {
            if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
            currentTurn.interventions.push({
                type: kind,
                channel: "chat",
                student_message: message,
                assistant_response: assistantMessage,
                student_audio_duration_seconds: studentAudioDurationSec,
                assistant_audio_duration_seconds: assistantAudioSec,
                rationale,
                follow_up_reason: parsed.action.follow_up_reason ?? null,
                client_timing: clientTiming,
                at: new Date().toISOString(),
            });
        }
        persist();
        const payload = { channel: "chat", assistant: assistantMessage, phase: sess.currentPhase, ...audio };
        if (kind === "hint" && parsed.action.hint) payload.audio_intelligibility = { hint: parsed.action.hint };
        return sendFinal(payload);
    }

    if (kind === "ask") {
        // ASK: o turno corrente é ACEITO (vira answer), e um NOVO turno é
        // criado para a próxima pergunta. Pode ser do plano (plan_question_id
        // referencia) ou espontânea (plan_question_id=null).
        if (currentTurn && currentTurn.answer == null) {
            currentTurn.answer = message;
            currentTurn.answered_at = new Date().toISOString();
            currentTurn.answer_audio_duration_seconds = studentAudioDurationSec;
            if (clientTiming) currentTurn.client_timing = clientTiming;
        }
        const planQId = parsed.action.plan_question_id ?? null;
        const planQuestion = planQId != null
            ? (sess.interviewPlan?.questions ?? []).find(q => q.id === planQId)
            : null;
        const nextTurnRef = planQuestion
            ? turnFromPlanQuestion(sess.turnLog.length, planQuestion)
            : {
                index: sess.turnLog.length,
                question: assistantMessage,
                rationale,
                answer: null,
                asked_at: new Date().toISOString(),
                answered_at: null,
                question_metadata: {
                    id: null,
                    spontaneous: true,
                    revisit_topic: parsed.action.revisit_topic ?? null,
                    objectives: parsed.action.objectives ?? [],
                    concerns: parsed.action.concerns ?? [],
                    decision_criteria: parsed.action.decision_criteria ?? [],
                    information_needs: parsed.action.information_needs ?? [],
                    evaluation_mode: parsed.action.evaluation_mode ?? [],
                },
            };
        // A fala em personagem vinda do agente substitui o texto cru da
        // pergunta do plano (mesma intenção, voz da persona). Mantém o
        // question_metadata original como auditoria.
        nextTurnRef.question = assistantMessage;
        nextTurnRef.question_audio_duration_seconds = assistantAudioSec;
        sess.turnLog.push(nextTurnRef);
        sess.questionIndex = sess.turnLog.length; // mantém monotônico p/ pending_questions do professor
        log.info("SUPER_ORQ", `ask plan_id=${planQId ?? "spontaneous"} idx=${sess.questionIndex}`);
        await pushAssistantVisible({ plan_question_id: planQId, spontaneous: planQId == null });
        persist();
        return sendFinal({ channel: "chat", assistant: assistantMessage, phase: sess.currentPhase, ...audio });
    }

    if (kind === "finalize") {
        // Finalize: captura a última resposta no currentTurn (se aberto), seta
        // phase=finalizing, envia a fala de despedida.
        if (currentTurn && currentTurn.answer == null) {
            currentTurn.answer = message;
            currentTurn.answered_at = new Date().toISOString();
            currentTurn.answer_audio_duration_seconds = studentAudioDurationSec;
            if (clientTiming) currentTurn.client_timing = clientTiming;
        }
        sess.currentPhase = "finalizing";
        sess.conversationCompleted = true;
        log.info("SUPER_ORQ", `finalize reason=${parsed.action.finalize_reason}`);
        await pushAssistantVisible({ finalize_reason: parsed.action.finalize_reason });
        // student_disengaged = aluno pediu pra parar pela conversa → "give_up"
        // (mesma semântica do botão Desistir). Demais razões = "complete".
        const completionReason = parsed.action.finalize_reason === "student_disengaged" ? "give_up" : "complete";
        // Despedida durável (B): persiste no conversation_json para sobreviver a
        // queda de conexão e aparecer na revisão do aluno e no log do professor.
        sess.finalization = {
            message: assistantMessage,
            completion_reason: completionReason,
            finalize_reason: parsed.action.finalize_reason ?? null,
            // Lacunas registradas pelo orquestrador ao avançar (guardrail de
            // insistência): persistidas aqui para o InterviewEvaluator vê-las.
            open_threads: Array.isArray(sess.superOrchestratorMemory?.open_threads) ? sess.superOrchestratorMemory.open_threads : [],
            at: new Date().toISOString(),
        };
        await persistFinalization(req, completionReason);
        await persist();
        // Estado terminal limpo: invariante runtime_state_json IS NULL ⇔ sem
        // tentativa em andamento. Sem isto a submissão ficava com
        // runtime_state_json não-nulo e current_phase="finalizing" para sempre
        // (in_flight fantasma no painel/analytics).
        try { await db.clearSubmissionRuntimeState(req.submission.id); }
        catch (err) { log.error("SUBMISSION", `clear runtime after finalize failed: ${err.message}`); }
        return sendFinal({ channel: "chat", assistant: assistantMessage, phase: sess.currentPhase, ...audio });
    }

    // Defensivo — kind desconhecido (não deveria, validateAction já checou).
    log.error("SUPER_ORQ", `kind inesperado: ${kind} — fallback genérico`);
    await pushAssistantVisible({ unknown_kind: kind });
    persist();
    return sendFinal({ channel: "chat", assistant: assistantMessage, phase: sess.currentPhase, ...audio });
});

// ============================================================================
// POST /s/:submissionToken/finalize
// ----------------------------------------------------------------------------
// Encerra a entrevista pelo botão "Desistir" (give_up). Após esta chamada,
// /chat, /upload e /audio devolvem 410 (via requireNotFinalized).
//
// IMPORTANTE — quem finaliza o quê:
//   - Fim NATURAL (plano esgotado / cap de turnos): é o handler de /chat que
//     finaliza no servidor (ramo `finalize` do super-orquestrador), gravando
//     completion_reason="complete" naquele momento. O frontend, ao ver
//     phase="finalizing", entra direto no modo revisão; eventual comentário do
//     aluno vai por POST /s/:t/comment, NÃO por aqui. Ou seja: chamar este
//     endpoint com "complete" após um fim natural devolve 409 (completion_reason
//     já setado) — esse caminho não é exercido pelo frontend hoje.
//   - DESISTÊNCIA: o botão "Desistir" durante a entrevista chama este endpoint
//     com completion_reason="give_up".
// "complete" segue aceito por compatibilidade (ex.: finalização sem passar pelo
// /chat), mas o fluxo padrão de fim natural não passa por aqui.
// Não é idempotente em sentido estrito, mas a checagem de completion_reason já
// setado devolve 409 numa segunda chamada.
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
        // Gate de vídeo obrigatório (ver persistFinalization / finalizeWithVideoGate):
        // com proctoring exigido e sem vídeo ainda, fica 'awaiting_video' e só
        // conclui quando o vídeo sobe (promoteAwaitingVideo no upload).
        const mandatory = videoMandatory(req.work) && req.submission.is_test !== true;
        const gateStatus = await db.finalizeWithVideoGate(req.submission.id, { mandatory, reason, comment });
        // Tenta atualizar a sessão em memória pra evitar uma janela em que ela
        // possa parecer ainda "viva". Tolerante a sess inexistente — sem sessão
        // em memória, os endpoints já estão bloqueados pelo middleware via DB.
        const sess = SESSIONS.get(req.submission.submission_token);
        if (sess) {
            sess.conversationCompleted = true;
            sess.currentPhase = "finalized";
        }
        log.info("SUBMISSION", `finalized token=${req.submission.submission_token} reason=${reason} status=${gateStatus} has_comment=${!!comment}`);
        res.json({ ok: true, completion_reason: reason, status: gateStatus });
    } catch (err) {
        log.error("SUBMISSION", `finalize failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "falha ao finalizar entrevista", detail: err.message });
    }
});

// ============================================================================
// GET /s/:submissionToken/review
// ----------------------------------------------------------------------------
// Pós-finalização: aluno tem REVIEW_WINDOW_DAYS dias para ver a conversa
// completa + ouvir as próprias gravações + deixar comentário ao professor.
// Acesso por submission_token Bearer (mesmo do resto). Após janela: 410.
// ============================================================================
router.get("/s/:submissionToken/review", requireSubmissionToken, async (req, res) => {
    const subId = req.submission.id;
    const win = reviewWindowState(req.submission);
    if (!req.submission.completion_reason) {
        return res.status(409).json({ error: "not_finalized", detail: "Entrevista ainda não foi encerrada." });
    }
    if (win.expired) {
        return res.status(410).json({ error: "review_window_expired", deadline: win.deadline });
    }
    try {
        const [convJson, audios] = await Promise.all([
            db.getConversationJson(subId),
            db.listStudentAudioArtifactsForSubmission(subId),
        ]);
        let conversation = null;
        if (convJson) {
            try { conversation = JSON.parse(convJson); }
            catch (err) {
                log.error("REVIEW", `conversation parse failed sub=${subId}: ${err.message}`);
                return res.status(500).json({ error: "failed_to_read_conversation" });
            }
        }
        const audioList = audios.map(a => ({
            audio_idx: a.audio_idx,
            mimetype: a.mimetype,
            duration_s: a.duration_s ? Number(a.duration_s) : null,
            byte_size: a.byte_size,
            audio_url: `/s/${encodeURIComponent(req.submission.submission_token)}/student-audio/${a.audio_idx}`,
        }));
        res.json({
            submission: {
                student_label: req.submission.student_label,
                completion_reason: req.submission.completion_reason,
                completed_at: req.submission.completed_at,
            },
            review_window: { deadline: win.deadline, days: REVIEW_WINDOW_DAYS },
            comment: {
                value: req.submission.student_comment ?? null,
                locked: !!req.submission.student_comment,
            },
            conversation,
            student_audio: audioList,
        });
    } catch (err) {
        log.error("REVIEW", `failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_load_review" });
    }
});

// Stream do áudio do aluno (LGPD self-access — a própria pessoa ouve a
// própria voz). Mesmo acesso que /review: dentro da janela e após finalize.
router.get("/s/:submissionToken/student-audio/:audioIdx", requireSubmissionToken, async (req, res) => {
    const audioIdx = Number.parseInt(req.params.audioIdx, 10);
    if (!Number.isFinite(audioIdx) || audioIdx < 0) return res.status(400).json({ error: "audio_idx inválido" });
    if (!req.submission.completion_reason) return res.status(409).json({ error: "not_finalized" });
    const win = reviewWindowState(req.submission);
    if (win.expired) return res.status(410).json({ error: "review_window_expired" });
    try {
        const artifact = await db.getStudentAudioArtifact({ submissionId: req.submission.id, audioIdx });
        if (!artifact) return res.status(404).json({ error: "audio not found" });
        const stream = await streamAudio(artifact.object_key);
        if (!stream) return res.status(503).json({ error: "audio_store_unavailable" });
        if (artifact.mimetype) res.type(artifact.mimetype);
        stream.on("error", err => {
            log.error("REVIEW", `audio stream error key=${artifact.object_key}: ${err.message}`);
            if (!res.headersSent) res.status(404).json({ error: "audio_not_in_store" });
            else res.end();
        });
        stream.pipe(res);
    } catch (err) {
        log.error("REVIEW", `audio fetch failed token=${req.submission.submission_token} idx=${audioIdx}: ${err.message}`);
        res.status(500).json({ error: "failed_to_fetch_audio" });
    }
});

// Devolutiva publicada pelo professor (versão formativa do StudentFeedbackAgent
// — NUNCA a avaliação interna). Diferente do /review, NÃO expira com a janela
// de 7 dias: a publicação pode acontecer semanas depois da entrevista, e a
// visibilidade é controlada pelo professor (evaluation_published_at).
router.get("/s/:submissionToken/evaluation", requireSubmissionToken, async (req, res) => {
    if (!req.submission.completion_reason) return res.status(409).json({ error: "not_finalized" });
    try {
        // Devolutiva (subjetiva) e nota (objetiva) são publicações INDEPENDENTES:
        // o aluno pode ver uma, outra, as duas ou nenhuma, em momentos diferentes.
        const [student, gradeInfo] = await Promise.all([
            db.getStudentEvaluation(req.submission.id),
            db.getPublishedStudentGrade(req.submission.id),
        ]);
        res.set("Cache-Control", "no-store");
        const devolutivaPublished = !!student?.published_at;
        res.json({
            published: devolutivaPublished,                          // compat: devolutiva
            published_at: student?.published_at ?? null,
            evaluation: devolutivaPublished ? student.report : null,
            grade_published: !!gradeInfo,
            grade_published_at: gradeInfo?.published_at ?? null,
            grade: gradeInfo?.grade ?? null,
        });
    } catch (err) {
        log.error("REVIEW", `evaluation fetch failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_load_evaluation" });
    }
});

// Submit do comentário ao professor. Single-shot: uma vez que student_comment
// estiver setado (não-null), não atualiza mais. Dentro da janela de revisão.
router.post("/s/:submissionToken/comment", requireSubmissionToken, express.json({ limit: "16kb" }), async (req, res) => {
    if (!req.submission.completion_reason) return res.status(409).json({ error: "not_finalized" });
    const win = reviewWindowState(req.submission);
    if (win.expired) return res.status(410).json({ error: "review_window_expired" });
    if (req.submission.student_comment) {
        return res.status(409).json({ error: "comment_already_submitted", detail: "Comentário já foi enviado e não pode ser editado." });
    }
    const raw = req.body?.comment;
    if (typeof raw !== "string") return res.status(400).json({ error: "comment é obrigatório (string)" });
    const trimmed = raw.trim().slice(0, MAX_COMMENT_LEN);
    if (!trimmed) return res.status(400).json({ error: "comment vazio" });
    try {
        await db.setSubmissionStudentComment(req.submission.id, trimmed);
        log.info("REVIEW", `comment submitted token=${req.submission.submission_token} chars=${trimmed.length}`);
        res.json({ ok: true, comment: trimmed });
    } catch (err) {
        log.error("REVIEW", `comment submit failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_save_comment" });
    }
});

export default router;

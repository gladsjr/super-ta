// Ciclo de vida da sessão do aluno: criação, hidratação após restart,
// validação dos recursos OpenAI, rebuild quando algum sumiu, áudio do
// entrevistador (TTS e reaproveitamento do último). Tudo que mexe na
// estrutura do `sess` vive aqui — exceto a lógica do /chat handler em si,
// que orquestra o turno e fica em routes/interview.js.
//
// Estado próprio: `SESSIONS` (map por submission_token) e `startLocks`
// (lock por token enquanto o /start está rodando o caminho de resume/rebuild).

import OpenAI from "openai";
import * as db from "./db.js";
import { openai } from "./openaiClient.js";
import { prepBuilderAgent, introductionAgent } from "./agents.js";
import {
    TTS_MODEL,
    INTERVIEW_QUESTION_COUNT,
} from "./config.js";
import { AudioCache, synthesizeSpeech } from "./audio.js";
import { getAudioDurationSeconds } from "./audioMeta.js";
import { meteredTts } from "./billing.js";
import { hydrate } from "./sessionState.js";
import { readConversationLog } from "./conversationLog.js";
import {
    persistConversationLog,
    logLastConvItem,
} from "./conversationUtils.js";
import { VOICES } from "../config/voices.js";
import { pickPersona } from "./personas.js";
import { attachNarratorAudio } from "./narrator.js";
import log from "./logger.js";

// Map por submission_token → sess em memória. Único ponto canônico.
export const SESSIONS = new Map();

// Lock por submission_token enquanto o /start está rodando o caminho de
// retomada/rebuild. Sem isso, duas abas concorrentes do mesmo aluno poderiam
// detectar simultaneamente que os recursos OpenAI sumiram e cada uma iniciaria
// seu próprio rebuild — criando vector stores e conversations órfãs.
export const startLocks = new Map(); // token → Promise<{sess, pendingAudio}>

// Helper para construir o contexto de cobrança a partir de uma sessão. Os
// agentes recebem `meterCtx` no último parâmetro e o repassam ao
// meteredResponses() em lib/billing.js, que registra o custo no work_token.
export function sessionMeterCtx(sess) {
    if (!sess) return null;
    return { workId: sess.workId ?? null, submissionId: sess.submissionId ?? null };
}

// Mapeia voiceId → gênero ("f" | "m" | "neutro") para alinhar o sorteio do
// nome do entrevistador com a voz escolhida no modo áudio. Em modo texto
// (voice == null) ou voz desconhecida, devolve null e o sorteio cai no
// caminho aleatório balanceado de pickPersona().
export function voiceGenderOf(voiceId) {
    if (!voiceId) return null;
    const v = VOICES.find(x => x.id === voiceId);
    return v ? v.gender : null;
}

// Cria Vector Store + indexa N files para RAG (file_search). Aceita array
// (caso novo do super-orquestrador: aluno + enunciado num só vector store)
// ou string única (compat legado).
export async function createVectorStoreWithFiles(fileIds, sessionId) {
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    try {
        const vectorStore = await openai.vectorStores.create({
            name: `session_${sessionId}_documents`,
            file_ids: ids,
        });
        log.info("UPLOAD", `vector store ${vectorStore.id} created with ${ids.length} file(s)`);
        return vectorStore.id;
    } catch (error) {
        log.error("UPLOAD", `vector store creation failed: ${error.message}`);
        throw error; // Fail fast — componente arquitetural crítico.
    }
}
// Compat: nome antigo continua exportado, redireciona pra versão array-aware.
export const createVectorStoreWithFile = createVectorStoreWithFiles;

// Estado projetado pro frontend do aluno.
export function sessionToClientState(sess) {
    // Modo áudio: ao reentrar, o aluno só ouve o último áudio do entrevistador.
    // Não enviamos histórico transcrito (regra do projeto: transcrição facilita
    // o uso de IA pelo aluno para responder). Em modo texto, mantém o histórico.
    const isAudio = (sess.interactionMode || "text") === "audio";
    return {
        currentPhase: sess.currentPhase,
        introStep: sess.introStep ?? null,
        questionCount: sess.questionCount,
        hasUpload: !!sess.submissionPath,
        interactionMode: sess.interactionMode || "text",
        voice: sess.voice || null,
        chat: isAudio ? [] : sess.conv_chat.map(m => ({ role: m.role, content: m.content })),
        // Os três campos abaixo são populados só no caminho de rehidratação após
        // restart. Permanecem false/null na sessão em memória normal.
        resumed: !!sess.resumed,
        rebuilt: !!sess.rebuilt,
        rebuild_reason: sess.rebuildReason ?? null,
    };
}

// Gera TTS para um trecho do entrevistador, caches em memória, e devolve
// { audio_url } pra anexar à resposta JSON. No modo texto, retorna {} —
// nenhum custo, nenhuma chamada à OpenAI. No modo áudio, falha de TTS é
// tratada como degradação graciosa: retorna { audio_error }.
export async function attachAudio(sess, content) {
    if (!content || sess.interactionMode !== "audio") return {};
    if (!sess.voice) {
        log.warn("AUDIO", `audio mode without voice (sess=${sess.submissionToken})`);
        return { audio_error: "no_voice_configured" };
    }
    try {
        const buffer = await meteredTts(
            { ...sessionMeterCtx(sess), model: TTS_MODEL, inputText: content },
            () => synthesizeSpeech(openai, TTS_MODEL, content, sess.voice)
        );
        const turnId = String(sess.audioTurnIdCounter++);
        sess.audioCache.set(turnId, buffer);
        const durationSec = await getAudioDurationSeconds(buffer, "audio/mpeg");
        // Lembra o último áudio do entrevistador para o re-entry: reload sem restart
        // reaproveita o buffer no cache, sem chamar TTS de novo.
        sess.lastInterviewerAudio = { turnId, durationSec };
        return {
            audio_url: `/s/${encodeURIComponent(sess.submissionToken)}/audio/${turnId}`,
            audio_duration_seconds: durationSec,
        };
    } catch (err) {
        log.error("AUDIO", `TTS failed: ${err.message}`);
        return { audio_error: "tts_failed" };
    }
}

// ============================================================================
// Pré-geração no /start (entrada da página do aluno).
// ----------------------------------------------------------------------------
// Disparada em background na entrada da página, paraleliza com o tempo morto
// entre carregar /student.html e o aluno clicar Enviar. Quando /upload chega,
// a saudação e o áudio do orientador já estão prontos em cache de sessão —
// /upload responde quase instantâneo. Snapshot da config (persona/voz/modo)
// é guardado junto: se mudar entre /start e /upload, invalida e regenera no
// caminho lento (fallback ao comportamento antigo).
// ============================================================================
export function pregenSnapshot(sess) {
    return {
        personaName: sess.interviewerPersona?.name ?? null,
        personaGender: sess.interviewerPersona?.gender ?? null,
        voice: sess.voice ?? null,
        mode: sess.interactionMode ?? null,
    };
}

function snapshotsMatch(a, b) {
    if (!a || !b) return false;
    return a.personaName === b.personaName
        && a.personaGender === b.personaGender
        && a.voice === b.voice
        && a.mode === b.mode;
}

async function preGenerateGreeting(sess, interviewerYamlText, meterCtx) {
    const snapshot = pregenSnapshot(sess);
    let greeting;
    try {
        greeting = await introductionAgent.evaluate({
            step: "ask_name",
            interviewerYamlText,
            persona: sess.interviewerPersona,
            introHistory: [],
            studentMessage: null,
            meterCtx,
            interactionMode: sess.interactionMode,
        });
    } catch (err) {
        log.error("PREGEN", `greeting LLM failed: ${err.message}`);
        return null;
    }
    let audio = {};
    if (sess.interactionMode === "audio") {
        audio = await attachAudio(sess, greeting.message);
    }
    sess.preGeneratedGreeting = {
        text: greeting.message,
        reason: greeting.reason,
        audio,
        snapshot,
    };
    log.info("PREGEN", `greeting ready snapshot=${snapshot.personaName}/${snapshot.voice}/${snapshot.mode} text=${log.preview(greeting.message, 80)}`);
    return sess.preGeneratedGreeting;
}

// Idempotente: se já existe pre-gen válido para o snapshot atual, não refaz.
// Chamado em /start (entrada da página) e em re-/start (reload, troca de aba).
// Operação fire-and-forget — armazena promessas em sess.{greeting,narrator}PreGenPromise
// para /upload aguardar. Falhas são engolidas para não bloquear /start; quem
// consome (/upload) detecta `preGeneratedGreeting` ausente e cai no caminho
// fresco.
export async function maybeKickOffPregeneration(sess, req) {
    if (sess.currentPhase !== "awaiting_upload") return;
    const cur = pregenSnapshot(sess);

    // Saudação: dispara só se ainda não temos um pré-gen válido para o snapshot
    // atual (e nenhum em vôo para esse snapshot).
    const greetingMatches = sess.preGeneratedGreeting
        && snapshotsMatch(sess.preGeneratedGreeting.snapshot, cur);
    const greetingInFlight = sess.greetingPreGenPromise
        && snapshotsMatch(sess.greetingPreGenSnapshot, cur);

    if (!greetingMatches && !greetingInFlight) {
        const yamlText = sess.interviewerYamlText ?? await db.getInterviewerYaml(req.work.id);
        if (yamlText) {
            sess.interviewerYamlText = yamlText;
            sess.preGeneratedGreeting = null; // invalida o anterior (se houver)
            sess.greetingPreGenSnapshot = cur;
            sess.greetingPreGenPromise = preGenerateGreeting(sess, yamlText, sessionMeterCtx(sess))
                .catch(err => { log.error("PREGEN", `greeting failed: ${err.message}`); return null; });
        } else {
            log.info("PREGEN", `skip greeting: professor ainda não configurou o entrevistador`);
        }
    }

    // Narrator: independente de persona (script fixo). Só depende do modo.
    if (sess.interactionMode === "audio" && !sess.narratorAudio?.buffer && !sess.narratorPreGenPromise) {
        sess.narratorPreGenPromise = attachNarratorAudio(sess, sessionMeterCtx(sess))
            .catch(err => { log.error("PREGEN", `narrator failed: ${err.message}`); return null; });
    }
}

// Devolve o áudio do último turno do entrevistador para o aluno ouvir ao
// reentrar. Caminho rápido: se ainda há buffer em sess.audioCache (reload
// no mesmo processo), reaproveita sem chamar TTS. Caminho lento: re-TTS
// da pergunta pendente (após restart do servidor ou LRU evict). Em modo
// texto, no-op.
//
// Retornos:
//   { audio_url, audio_duration_seconds }  → ok, tocar
//   { error: "tts_failed" }                → falha, frontend mostra retry
//   null                                    → sem áudio pendente (janela
//                                             entre resposta do aluno e
//                                             próxima pergunta) ou modo texto
export async function maybeRebuildPendingQuestionAudio(sess) {
    if (sess.interactionMode !== "audio") return null;

    // Caminho rápido: aproveitar o áudio já gerado.
    const cached = sess.lastInterviewerAudio;
    if (cached && sess.audioCache?.has(cached.turnId)) {
        return {
            audio_url: `/s/${encodeURIComponent(sess.submissionToken)}/audio/${cached.turnId}`,
            audio_duration_seconds: cached.durationSec ?? null,
        };
    }

    // Caminho lento: identificar o texto pendente e re-TTS.
    let pendingText = null;
    if (sess.currentPhase === "intro") {
        for (let i = sess.introLog.length - 1; i >= 0; i--) {
            if (sess.introLog[i].role === "assistant") {
                pendingText = sess.introLog[i].content;
                break;
            }
        }
    } else if (sess.currentPhase === "interviewing") {
        const last = sess.turnLog[sess.turnLog.length - 1];
        if (last && last.answer == null) {
            // Conteúdo "visível" (frase de transição + pergunta) está na última msg
            // assistant em conv_chat — reconstruída pelo replay quando hydrate.
            for (let i = sess.conv_chat.length - 1; i >= 0; i--) {
                if (sess.conv_chat[i].role === "assistant") {
                    pendingText = sess.conv_chat[i].content;
                    break;
                }
            }
        }
    }
    if (!pendingText) return null;
    const audio = await attachAudio(sess, pendingText);
    if (audio.audio_url) {
        return {
            audio_url: audio.audio_url,
            audio_duration_seconds: audio.audio_duration_seconds ?? null,
        };
    }
    if (audio.audio_error) return { error: "tts_failed" };
    return null;
}

// Pré-processamento que roda em background no /upload, em paralelo com a
// saudação: PDF do aluno no DB, uploads para a OpenAI, vector store,
// document map e plano de entrevista. Atualiza `sess.interviewPlan` etc.
//
// Cada etapa envolvida em uma "step" rotulada para que o erro identifique
// exatamente o que falhou. A promessa REJEITA em caso de falha (não usamos
// `.catch` engolidor) — quem aguarda recebe a causa raiz. Pode ser invocada
// novamente em retry usando `sess.preparationInputs`.
export function startInterviewPreparation(sess) {
    const params = sess.preparationInputs;
    if (!params) throw new Error("startInterviewPreparation: missing preparationInputs");
    sess.interviewPreparationError = null;
    sess.interviewPreparation = (async () => {
        try {
            log.info("PREP", `step=upload start submission=${params.token}`);
            const [, studentFile, enunciadoFile] = await Promise.all([
                db.setStudentPdf(params.submissionId, params.studentBuffer, params.studentFilename),
                openai.files.create({
                    file: await OpenAI.toFile(params.studentBuffer, params.studentFilename),
                    purpose: "user_data",
                }),
                openai.files.create({
                    file: await OpenAI.toFile(params.enunciadoBlob.pdf, params.enunciadoBlob.filename || "enunciado.pdf"),
                    purpose: "user_data",
                }),
            ]).catch(err => { throw new Error(`step=upload failed: ${err.message}`); });
            sess.openaiFileId = studentFile.id;
            log.info("PREP", `step=upload ok student=${studentFile.id} enunciado=${enunciadoFile.id}`);

            // FASE 2 do super-orquestrador: substitui MapBuilder+PlanBuilder
            // por PrepBuilder em duas chamadas serializadas (analyze → plan).
            // Em paralelo com a análise, criamos o vector store com OS DOIS
            // PDFs (aluno + enunciado) — extensão prevista no plano para o
            // super-orquestrador poder cruzar "o que foi pedido vs entregue".
            //
            // Trade-off vs versão antiga (map+plan paralelo): perdemos um
            // pouco de paralelismo (plan agora depende da análise), mas
            // ganhamos qualidade do plano (informado pela análise) e o vector
            // store passa a ter os 2 docs. Latência adicional cabe na janela
            // do intro (que roda paralelo com a prep). Ver
            // docs/super-orchestrator-plan.md.
            log.info("PREP", "step=parallel(vector_store,analyzeWork) start");
            const stage1 = await Promise.allSettled([
                createVectorStoreWithFiles([studentFile.id, enunciadoFile.id], params.token),
                prepBuilderAgent.analyzeWork({
                    studentFileId: studentFile.id,
                    enunciadoFileId: enunciadoFile.id,
                    interviewerYamlText: sess.interviewerYamlText,
                    meterCtx: params.meterCtx,
                }),
            ]);
            const stage1Labels = ["vector_store", "work_analysis"];
            const stage1Failures = stage1
                .map((r, i) => r.status === "rejected" ? `${stage1Labels[i]}: ${r.reason?.message ?? r.reason}` : null)
                .filter(Boolean);
            if (stage1Failures.length > 0) {
                throw new Error(`step=parallel failed (${stage1Failures.join(" | ")})`);
            }
            const [vsRes, analysisRes] = stage1;
            sess.vectorStoreId = vsRes.value;
            sess.workAnalysis = analysisRes.value;
            // Compat com o nome legado `documentMap` — conversation.html e o
            // path de rebuild ainda lêem `document_map` (JSON.stringify direto
            // para o professor). Cai como mesmo objeto; field rename é cleanup
            // de fase posterior.
            sess.documentMap = sess.workAnalysis;
            log.info("PREP", `stage1 ok vector_store=${sess.vectorStoreId}`);

            log.info("PREP", "step=buildPlan start");
            try {
                sess.interviewPlan = await prepBuilderAgent.buildPlan({
                    analysis: sess.workAnalysis,
                    studentFileId: studentFile.id,
                    enunciadoFileId: enunciadoFile.id,
                    interviewerYamlText: sess.interviewerYamlText,
                    questionCount: INTERVIEW_QUESTION_COUNT,
                    meterCtx: params.meterCtx,
                });
            } catch (err) {
                throw new Error(`step=buildPlan failed: ${err.message}`);
            }
            log.info("INTERVIEW_PLAN", `submission=${params.token} questions=${sess.interviewPlan.questions.length}`);
            log.info("INTERVIEW_PLAN", `full plan:\n${JSON.stringify(sess.interviewPlan, null, 2)}`);

            try {
                await openai.conversations.items.create(sess.conversationId_eval, {
                    items: [{ role: "developer", content: `[WORK_ANALYSIS] ${JSON.stringify(sess.workAnalysis, null, 2)}` }],
                });
                await logLastConvItem(sess.conversationId_eval, "CONV:eval");
            } catch (err) {
                // Conversation log remoto não é fatal — só registra.
                log.error("PREP", `remote eval write (work_analysis) failed: ${err.message}`);
            }

            // Persist agora para capturar interview_plan/document_map/vector_store_id
            // no runtime_state. Sem isso, um restart do servidor entre prep-completa e
            // o próximo /chat perderia o plano e forçaria reconstrução desnecessária.
            await persistConversationLog(sess);

            log.info("PREP", `done submission=${params.token}`);
        } catch (err) {
            log.error("PREP", `prep failed submission=${params.token}: ${err.message}`);
            sess.interviewPreparationError = err;
            throw err;
        }
    })();
    // .catch silencioso para evitar UnhandledPromiseRejection — quem realmente
    // precisa do erro chama `await sess.interviewPreparation` num try/catch.
    sess.interviewPreparation.catch(() => { });
}

// Classifica um erro de retrieve da OpenAI. "not_found" → recurso sumiu,
// precisa rebuild. "transient" → rede/5xx/timeout: NÃO faz rebuild (caro e
// irreversível); melhor 503 e o aluno recarrega a página. "other" → cai no
// caminho transient para segurança (não rebuilda à toa).
export function classifyOpenAIError(err) {
    if (!err) return "transient";
    const status = err.status ?? err.statusCode ?? null;
    if (status === 404) return "not_found";
    const msg = String(err.message || "").toLowerCase();
    if (msg.includes("not found") || msg.includes("no such")) return "not_found";
    return "transient";
}

// Verifica em paralelo se os quatro recursos OpenAI guardados na sessão
// rehidratada ainda existem (e estão usáveis). Devolve { ok, missing } onde
// missing é a lista de razões para rebuild (ex.: "vector_store_404",
// "vector_store_inactive", "conversation_chat_404", "file_404"). Erros
// transientes (rede/5xx) viram throw — o caller traduz para 503.
export async function validateResources(sess) {
    const results = await Promise.allSettled([
        openai.vectorStores.retrieve(sess.vectorStoreId),
        openai.files.retrieve(sess.openaiFileId),
        openai.conversations.retrieve(sess.conversationId_chat),
        openai.conversations.retrieve(sess.conversationId_eval),
    ]);
    const missing = [];
    const labels = ["vector_store", "file", "conversation_chat", "conversation_eval"];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
            if (labels[i] === "vector_store") {
                const st = r.value?.status;
                if (st && st !== "completed" && st !== "in_progress") {
                    missing.push("vector_store_inactive");
                }
            }
            continue;
        }
        const kind = classifyOpenAIError(r.reason);
        if (kind === "not_found") {
            missing.push(`${labels[i]}_404`);
        } else {
            const detail = r.reason?.message || String(r.reason);
            throw new Error(`validateResources: ${labels[i]} transient error: ${detail}`);
        }
    }
    return { ok: missing.length === 0, missing };
}

// Reconstrói os recursos OpenAI que sumiram (vector store + files + conversations),
// re-injeta o document_map (reusado do runtime_state) no novo conversationId_eval,
// e faz replay do histórico visível nas duas conversations novas. Mutates `sess`.
// Não dispara PlanBuilder de novo — o plano vem do runtime.
export async function rebuildSession(sess, reason) {
    log.info("REBUILD", `submission=${sess.submissionToken} reason=${reason}`);
    const [studentBlob, enunciadoBlob] = await Promise.all([
        db.getStudentPdfBlob(sess.submissionId),
        db.getEnunciadoBlob(sess.workId),
    ]);
    if (!studentBlob) throw new Error("rebuildSession: student_pdf ausente no DB");
    if (!enunciadoBlob) throw new Error("rebuildSession: enunciado_pdf ausente no DB");

    // Em paralelo: re-upload dos dois PDFs, criar duas Conversations novas.
    const [studentFile, enunciadoFile, chatConversation, evalConversation] = await Promise.all([
        openai.files.create({
            file: await OpenAI.toFile(studentBlob.pdf, studentBlob.filename || "student.pdf"),
            purpose: "user_data",
        }),
        openai.files.create({
            file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
            purpose: "user_data",
        }),
        openai.conversations.create({ metadata: { submission_token: sess.submissionToken, type: "chat", rebuilt: "1" } }),
        openai.conversations.create({ metadata: { submission_token: sess.submissionToken, type: "eval", rebuilt: "1" } }),
    ]);

    // Vector store agora carrega os dois PDFs (aluno + enunciado), consistente
    // com a /upload nova. O super-orquestrador na fase 3 vai precisar consultar
    // os dois via file_search.
    const vectorStoreId = await createVectorStoreWithFiles(
        [studentFile.id, enunciadoFile.id],
        sess.submissionToken,
    );

    sess.openaiFileId = studentFile.id;
    sess.vectorStoreId = vectorStoreId;
    sess.conversationId_chat = chatConversation.id;
    sess.conversationId_eval = evalConversation.id;

    // Re-injeta a análise (work_analysis) no novo eval. Preferência: usa o
    // novo workAnalysis; cai pra documentMap legado se vier de uma sessão
    // antiga sem o bloco super_orchestrator.
    const analysisToInject = sess.workAnalysis ?? sess.documentMap;
    if (analysisToInject) {
        const tag = sess.workAnalysis ? "WORK_ANALYSIS" : "DOCUMENT_MAP";
        try {
            await openai.conversations.items.create(sess.conversationId_eval, {
                items: [{ role: "developer", content: `[${tag}] ${JSON.stringify(analysisToInject, null, 2)}` }],
            });
        } catch (err) {
            log.error("REBUILD", `re-inject ${tag.toLowerCase()} failed: ${err.message}`);
        }
    }
    // Replay do histórico visível em ambas as conversations. Um único create por
    // conversation com todos os items, na ordem que a hydrate reconstruiu.
    if (sess.conv_chat.length > 0) {
        try {
            await openai.conversations.items.create(sess.conversationId_chat, {
                items: sess.conv_chat.map(m => ({ role: m.role, content: m.content })),
            });
        } catch (err) {
            log.error("REBUILD", `replay chat failed: ${err.message}`);
        }
    }
    if (sess.conv_eval.length > 0) {
        try {
            await openai.conversations.items.create(sess.conversationId_eval, {
                items: sess.conv_eval.map(m => ({ role: m.role, content: m.content })),
            });
        } catch (err) {
            log.error("REBUILD", `replay eval failed: ${err.message}`);
        }
    }

    sess.rebuilt = true;
    sess.rebuildReason = reason;
    log.info("REBUILD", `submission=${sess.submissionToken} ok vs=${vectorStoreId} chat=${chatConversation.id} eval=${evalConversation.id}`);

    // Persist imediato para os novos IDs sobreviverem a outro restart.
    await persistConversationLog(sess);
}

// Cria a sessão "fresca" (awaiting_upload) — caminho original do /start
// quando não há nada no banco para retomar.
export async function createFreshSession(req) {
    const token = req.submission.submission_token;
    const [chatConversation, evalConversation] = await Promise.all([
        openai.conversations.create({ metadata: { submission_token: token, type: "chat" } }),
        openai.conversations.create({ metadata: { submission_token: token, type: "eval" } }),
    ]);
    const identityOverride = req.work.interviewer_name && req.work.interviewer_gender
        ? { name: req.work.interviewer_name, gender: req.work.interviewer_gender }
        : null;
    const interviewerPersona = pickPersona({
        voiceGender: voiceGenderOf(req.work.voice),
        overrides: identityOverride,
    });
    const sess = {
        submissionToken: token,
        workToken: req.work.work_token,
        workId: req.work.id,
        submissionId: req.submission.id,
        studentLabel: req.submission.student_label,
        conversationId_chat: chatConversation.id,
        conversationId_eval: evalConversation.id,
        conv_chat: [],
        conv_eval: [],
        history: [],
        documentMap: null,
        submissionPath: null,
        openaiFileId: null,
        vectorStoreId: null,
        currentPhase: "awaiting_upload",
        questionIndex: 0,
        questionCount: 0,
        interviewerPersona,
        introLog: [],
        introStep: null,
        studentName: null,
        introTransitionedAt: null,
        interviewPreparation: null,
        // Bloco do super-orquestrador (experimento). workAnalysis populado pelo
        // PrepBuilder em startInterviewPreparation; superOrchestratorMemory
        // populado turno a turno pelo SuperOrchestratorAgent (fase 3).
        workAnalysis: null,
        superOrchestratorMemory: null,
        interactionMode: req.work.interaction_mode || "text",
        voice: req.work.voice || null,
        audioCache: new AudioCache(10),
        audioTurnIdCounter: 0,
        lastInterviewerAudio: null,
        resumed: false,
        rebuilt: false,
        rebuildReason: null,
    };
    log.info("SUBMISSION", `start token=${token} work=${req.work.work_token} mode=${sess.interactionMode} voice=${sess.voice ?? "-"} persona=${interviewerPersona.name}/${interviewerPersona.city} chat=${chatConversation.id} eval=${evalConversation.id}`);
    return sess;
}

// Caminho "novo" do /start: sessão inexistente em memória, mas pode haver
// estado persistido no banco (retomada após restart). Retorna o sess
// pronto e o áudio da pergunta pendente (modo áudio) quando aplicável.
//
// IMPORTANTE: roda dentro do startLocks; concorrentes aguardam o resultado.
export async function initOrResumeSession(req) {
    const token = req.submission.submission_token;
    const studentBlobPresent = await db.hasStudentPdf(req.submission.id);

    // Caso 1: sem PDF do aluno ainda → sessão fresca em awaiting_upload.
    if (!studentBlobPresent) {
        const sess = await createFreshSession(req);
        SESSIONS.set(token, sess);
        // Dispara pré-geração da saudação e do orientador EM BACKGROUND.
        // Roda em paralelo com o tempo morto entre página carregar e aluno
        // clicar Enviar. /upload aguarda essas promessas e usa o resultado
        // direto, sem chamar LLM/TTS no caminho síncrono.
        try { await maybeKickOffPregeneration(sess, req); }
        catch (err) { log.error("PREGEN", `kickoff failed: ${err.message}`); }
        return { sess, pendingAudio: null };
    }

    // Caso 2: PDF presente → tenta retomar do banco.
    const runtimeRow = await db.getSubmissionRuntimeState(req.submission.id);
    if (!runtimeRow || !runtimeRow.runtime_state || !runtimeRow.runtime_state.schema_version) {
        const err = new Error("legacy_submission");
        err.statusCode = 409;
        err.publicMessage = "Esta entrevista foi iniciada em uma versão anterior do sistema. Peça ao professor para gerar um novo envio.";
        throw err;
    }

    const conversationLog = await readConversationLog(req.submission.id);
    if (!conversationLog) {
        const err = new Error("missing_conversation_log");
        err.statusCode = 409;
        err.publicMessage = "Estado inconsistente da entrevista. Peça ao professor para gerar um novo envio.";
        throw err;
    }

    const sess = hydrate({
        submission: req.submission,
        work: req.work,
        runtimeRow,
        conversationLog,
    });
    sess.studentLabel = req.submission.student_label;
    log.info("SUBMISSION", `resume(db) token=${token} phase=${sess.currentPhase} qn=${sess.questionCount} mode=${sess.interactionMode}`);

    // Valida recursos OpenAI em paralelo. Erro transiente → 503 (não rebuild).
    // 404 ou inativo → reconstrói.
    let validation;
    try {
        validation = await validateResources(sess);
    } catch (err) {
        const wrapped = new Error(`openai_transient: ${err.message}`);
        wrapped.statusCode = 503;
        wrapped.publicMessage = "Falha temporária ao validar a entrevista. Tente recarregar a página.";
        throw wrapped;
    }
    if (!validation.ok) {
        const reason = validation.missing[0];
        await rebuildSession(sess, reason);
    }

    // Cenário "morri durante a prep": current_phase=intro mas interview_plan=null.
    // Reconstrói preparationInputs e dispara em background — o handler de intro
    // (em /chat) já tem o loop de await/retry sobre sess.interviewPreparation.
    if (sess.currentPhase === "intro" && sess.interviewPlan == null) {
        const [interviewerYamlText, enunciadoBlob, studentBlob] = await Promise.all([
            db.getInterviewerYaml(req.work.id),
            db.getEnunciadoBlob(req.work.id),
            db.getStudentPdfBlob(req.submission.id),
        ]);
        if (interviewerYamlText && enunciadoBlob && studentBlob) {
            sess.interviewerYamlText ??= interviewerYamlText;
            sess.preparationInputs = {
                submissionId: req.submission.id,
                studentBuffer: studentBlob.pdf,
                studentFilename: studentBlob.filename || "student.pdf",
                enunciadoBlob,
                meterCtx: sessionMeterCtx(sess),
                token,
            };
            log.info("SUBMISSION", `resume: re-disparando prep que ficou em vôo (token=${token})`);
            startInterviewPreparation(sess);
        } else {
            log.warn("SUBMISSION", `resume: prep em vôo mas inputs incompletos (yaml=${!!interviewerYamlText} enunciado=${!!enunciadoBlob} student=${!!studentBlob})`);
        }
    }

    // Modo áudio: re-TTS apenas da pergunta pendente, para o aluno ouvir.
    const pendingAudio = await maybeRebuildPendingQuestionAudio(sess);

    SESSIONS.set(token, sess);
    return { sess, pendingAudio };
}

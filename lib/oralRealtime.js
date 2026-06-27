// Relay da PROVA ORAL (Realtime) — o servidor fica NO MEIO da conversa.
//
// Topologia: navegador ↔ (WebSocket) ↔ NOSSO servidor ↔ (WebSocket) ↔ OpenAI.
// O navegador manda o áudio do microfone em PCM16 24kHz (frames binários) e
// recebe o áudio do examinador em PCM16 24kHz (frames binários). Eventos de
// controle vão em JSON (texto). A nossa OPENAI_API_KEY nunca vai ao navegador.
//
// Por que relay (e não WebRTC direto): funciona em rede corporativa (WS/443),
// permite metering autoritativo do custo (lemos response.done.usage no
// servidor) e coloca o servidor no loop para guardrails e contexto adaptativo.
//
// Sem transcrição (decisão de produto: é prova oral; nada de legenda). O modelo
// fala-a-fala entende o áudio direto; a transcrição não é necessária.

import { WebSocketServer, WebSocket } from "ws";
import * as db from "./db.js";
import { REALTIME_MODEL } from "./config.js";
import { recordRealtimeCost } from "./billing.js";
import log from "./logger.js";

// Sorteia N itens mantendo a ordem original entre os escolhidos.
export function sampleKeepingOrder(arr, n) {
    if (n >= arr.length) return arr.slice();
    const idx = arr.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, n).sort((a, b) => a - b).map(i => arr[i]);
}

// Rastreador de LATÊNCIA de resposta (sinalizador de "cola" por voz): mede o
// tempo entre o examinador terminar a pergunta e o aluno COMEÇAR a responder.
// Pausa longa seguida de resposta substancial é o clássico "foi consultar".
// É só um SINAL para revisão humana — nunca acusação. Função pura, testável.
export function makeLatencyTracker(thresholdSec = 7) {
    const turns = [];
    let examinerDoneAt = null;
    let pendingGap = null;
    return {
        examinerDone(t) { examinerDoneAt = t; },
        studentStart(t) {
            if (examinerDoneAt != null && pendingGap == null) pendingGap = Math.max(0, (t - examinerDoneAt) / 1000);
        },
        studentAnswer(text) {
            if (pendingGap == null) return;
            const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
            turns.push({ q: turns.length + 1, gap_sec: Math.round(pendingGap * 10) / 10, answer_words: words });
            pendingGap = null; examinerDoneAt = null;
        },
        summary() {
            // Sinaliza só pausa longa ANTES de resposta substancial (≥5 palavras):
            // pausar e dizer "não sei" não é suspeito.
            const flagged = turns.filter(g => g.gap_sec >= thresholdSec && g.answer_words >= 5);
            return {
                threshold_sec: thresholdSec,
                turns,
                max_gap_sec: turns.length ? Math.max(...turns.map(g => g.gap_sec)) : 0,
                flagged_count: flagged.length,
                flagged,
            };
        },
    };
}

// Instruções da sessão: persona fixa de examinador + protocolo + SÓ as
// perguntas (o gabarito nunca sai do servidor).
export function buildExamInstructions(questions, examName) {
    const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    return `Você é um EXAMINADOR conduzindo uma PROVA ORAL por voz, em português do Brasil${examName ? ` ("${examName}")` : ""}. Seu ÚNICO papel é aplicar a prova abaixo.

PROTOCOLO (siga à risca):
- Comece se apresentando em 1 frase ("Olá, vou conduzir sua prova oral.") e, NA MESMA abertura, deixe claro que o aluno pode, A QUALQUER MOMENTO, pedir para você REPETIR a pergunta ou FALAR MAIS DEVAGAR — como faria com um examinador humano. Depois faça a PRIMEIRA pergunta.
- Faça UMA pergunta por vez, EXATAMENTE como listadas e na ORDEM. Espere o aluno terminar de responder antes de seguir.
- DÊ TEMPO ao aluno: ele pode pausar para pensar NO MEIO da resposta — espere ele CLARAMENTE terminar antes de falar. NUNCA o interrompa, NUNCA o apresse, não complete a fala dele nem emende a próxima pergunta em cima da resposta.
- Se você NÃO entender bem o que o aluno disse, ou se a resposta vier cortada / parecer não fazer sentido, NÃO presuma: PERGUNTE, peça para repetir, ou CONFIRME o que entendeu antes de prosseguir ("Só confirmando: você disse que...?").
- Após cada resposta, faça apenas um reconhecimento NEUTRO e curto ("Entendi.", "Certo.") e passe à próxima. NÃO diga se está certo ou errado. NÃO corrija, NÃO ensine, NÃO dê dicas.
- NUNCA invente perguntas novas, NUNCA pule perguntas, NUNCA revele respostas ou gabarito.
- Depois da resposta à ÚLTIMA pergunta, agradeça em 1 frase e ENCERRE ("Era isso. Obrigado, a prova está encerrada.").
- Fale de forma clara, pausada e cordial. Mantenha suas falas curtas.

PERGUNTAS DA PROVA (na ordem):
${list}`;
}

const FMT = { type: "audio/pcm", rate: 24000 };

// Monta a config da sessão Realtime (server-to-server). Sem transcrição.
function buildSessionConfig({ instructions, voice }) {
    return {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions,
        audio: {
            input: {
                format: FMT,
                // Transcrição SÓ como registro no servidor (não vai ao aluno; sem
                // legenda ao vivo). Serve para a avaliação comparar com o gabarito.
                transcription: { model: "gpt-4o-transcribe" },
                // interrupt_response: o examinador PARA de falar quando o aluno
                // começa (barge-in, como o ChatGPT de voz).
                turn_detection: { type: "semantic_vad", eagerness: "medium", interrupt_response: true, create_response: true },
            },
            output: { format: FMT, voice },
        },
    };
}

// Autentica o token de submissão e devolve {submission, work, questions} ou erro.
async function authConnect(submissionToken) {
    const found = await db.findSubmissionByToken(String(submissionToken || "").toLowerCase());
    if (!found) return { error: "submission not found" };
    if (found.is_blocked) return { error: "blocked" };
    if (found.work_kind !== "oral_realtime") return { error: "not an oral exam" };
    if (found.work_is_active === false) return { error: "work inactive" };
    // Sem retake: prova já concluída não pode ser refeita (exceto tokens de teste).
    if (found.completion_reason && !found.is_test) return { error: "already_done" };
    // Consentimento (voz+vídeo) é obrigatório e verificado no SERVIDOR — o aluno
    // precisa ter aceitado (POST /oral/consent) antes de abrir a sessão de voz.
    // Fecha o bypass de conectar direto no WebSocket pulando o termo. (#53)
    if (!found.consent_version) return { error: "consent_required" };
    const questions = await db.getOralQuestions(found.work_id);
    if (!questions.length) return { error: "exam not prepared" };
    return { found, questions };
}

// Sessões de prova oral ATIVAS no momento (por submission_token) — impede duas
// provas simultâneas com o mesmo token (#52). Em memória; basta nesta instância.
const activeSessions = new Set();

// Ponte de UMA conexão do navegador com a OpenAI.
function bridge(clientWs, { found, questions }) {
    const token = found.submission_token;
    const n = Math.min(found.work_question_count || questions.length, questions.length);
    const sampled = sampleKeepingOrder(questions, n);
    const voice = found.work_voice || "verse";
    const instructions = buildExamInstructions(sampled.map(q => q.question), found.work_name);

    const usageAcc = []; // acumula usage de cada response.done (metering)
    const transcript = []; // registro [{role,text}] para a avaliação (não vai ao aluno)
    const lat = makeLatencyTracker(); // sinalizador: latência de resposta
    let oaiOpen = false;
    let cleanFinish = false; // só marca concluída quando o aluno ENCERRA (bye), não quando a aba cai (#54)
    const oai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    const sendClient = (obj) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj)); };
    const sendClientAudio = (buf) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(buf, { binary: true }); };

    oai.on("open", () => {
        oaiOpen = true;
        oai.send(JSON.stringify({ type: "session.update", session: buildSessionConfig({ instructions, voice }) }));
        // o modelo não inicia sozinho: pedimos a 1ª resposta (apresentação + 1ª pergunta).
        oai.send(JSON.stringify({ type: "response.create" }));
        sendClient({ type: "status", state: "connected", total_questions: n });
        log.info("ORAL_RELAY", `bridge open submission=${token} n=${n} voice=${voice}`);
    });

    oai.on("message", (data, isBinary) => {
        if (isBinary) return; // a OpenAI manda áudio como base64 em JSON, não binário
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        switch (m.type) {
            // áudio do examinador (PCM16 base64) → repassa binário ao navegador
            case "response.output_audio.delta":
            case "response.audio.delta":
                if (m.delta) sendClientAudio(Buffer.from(m.delta, "base64"));
                break;
            case "input_audio_buffer.speech_started":
                lat.studentStart(Date.now()); // início da fala do aluno → fecha o gap
                sendClient({ type: "status", state: "listening" }); break;
            case "input_audio_buffer.speech_stopped":
                sendClient({ type: "status", state: "thinking" }); break;
            // Registro da transcrição (server-side, não vai ao aluno).
            case "response.output_audio_transcript.done":
            case "response.audio_transcript.done":
                if (m.transcript) transcript.push({ role: "examiner", text: m.transcript });
                break;
            case "conversation.item.input_audio_transcription.completed":
                if (m.transcript) { transcript.push({ role: "student", text: m.transcript }); lat.studentAnswer(m.transcript); }
                break;
            case "response.done":
                if (m.response?.usage) usageAcc.push(m.response.usage);
                lat.examinerDone(Date.now()); // examinador terminou de falar → começa a contar o gap
                break;
            case "error":
                log.error("ORAL_RELAY", `openai error submission=${token}: ${JSON.stringify(m.error || m).slice(0, 200)}`);
                break;
        }
    });

    oai.on("close", () => { sendClient({ type: "ended" }); try { clientWs.close(); } catch {} });
    oai.on("error", (e) => { log.error("ORAL_RELAY", `openai ws error submission=${token}: ${e.message}`); try { clientWs.close(); } catch {} });

    // navegador → OpenAI
    clientWs.on("message", (data, isBinary) => {
        if (!oaiOpen) return;
        if (isBinary) {
            // frame de áudio do microfone (PCM16 24kHz) → append base64
            oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(data).toString("base64") }));
        } else {
            // controle JSON do cliente (ex.: {type:'bye'})
            let m; try { m = JSON.parse(data.toString()); } catch { return; }
            if (m.type === "bye") { cleanFinish = true; try { oai.close(); } catch {} }
        }
    });

    clientWs.on("close", async () => {
        try { oai.close(); } catch {}
        activeSessions.delete(token); // libera o token p/ uma nova sessão (#52)
        // METERING (R1): grava o custo da sessão a partir do usage acumulado.
        try {
            await recordRealtimeCost({
                workId: found.work_id,
                submissionId: found.id,
                model: REALTIME_MODEL,
                usages: usageAcc,
            });
        } catch (err) {
            log.error("ORAL_RELAY", `metering failed submission=${token}: ${err.message}`);
        }
        // Registro da transcrição (para a avaliação comparar com o gabarito).
        if (transcript.length > 0) {
            try { await db.setOralTranscript(found.id, transcript); }
            catch (err) { log.error("ORAL_RELAY", `setTranscript failed submission=${token}: ${err.message}`); }
        }
        // Sinalizador de voz: latência de resposta (gap pergunta→resposta).
        try {
            await db.setOralVoice(found.id, { latency: lat.summary(), captured_at: new Date().toISOString() });
        } catch (err) { log.error("ORAL_RELAY", `setVoice failed submission=${token}: ${err.message}`); }
        // No-retake: marca como concluída SÓ quando o aluno ENCERROU de fato
        // (clicou "Encerrar" → bye). Fechar a aba/cair no meio NÃO consome a
        // tentativa — o aluno pode reabrir e refazer. (#54) Idempotente.
        if (cleanFinish && usageAcc.length > 0) {
            try { await db.markOralExamCompleted(found.id); }
            catch (err) { log.error("ORAL_RELAY", `markCompleted failed submission=${token}: ${err.message}`); }
        }
        log.info("ORAL_RELAY", `bridge closed submission=${token} clean=${cleanFinish} responses=${usageAcc.length}`);
    });
}

// Anexa o servidor WebSocket ao http server, tratando o upgrade na rota
// /s/:submissionToken/oral/relay.
export function attachOralRelay(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", async (req, socket, head) => {
        let pathname;
        try { pathname = new URL(req.url, "http://x").pathname; } catch { socket.destroy(); return; }
        const match = pathname.match(/^\/s\/([0-9a-f]{12})\/oral\/relay$/i);
        if (!match) return; // outras rotas de upgrade (se houver) seguem o fluxo normal
        const auth = await authConnect(match[1]);
        if (auth.error) {
            log.warn("ORAL_RELAY", `upgrade rejeitado (${auth.error}) path=${pathname}`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
        }
        // Uma sessão por token (#52): rejeita uma 2ª conexão simultânea com o
        // mesmo token. O lock é liberado quando a sessão ativa fecha.
        const tok = auth.found.submission_token;
        if (activeSessions.has(tok)) {
            log.warn("ORAL_RELAY", `upgrade rejeitado (in_use) token=${tok}`);
            socket.write("HTTP/1.1 409 Conflict\r\n\r\n"); socket.destroy(); return;
        }
        activeSessions.add(tok);
        wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, auth));
    });
    log.info("BOOT", "oral relay (WebSocket) anexado em /s/:token/oral/relay");
}
